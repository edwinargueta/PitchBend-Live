"""The ingest flow shared by YouTube and upload jobs (ARCHITECTURE.md §10 A3-A5, §6.5).

    claim job -> fetching -> [source-specific fetch] -> processing (normalize to AAC m4a)
    -> atomic move to MEDIA_DIR/<uuid4>.m4a -> track ready -> audio_ready
    -> analyzing (key detection, non-fatal) -> key_ready | error KEY_DETECTION_FAILED -> done

``audio_ready`` is always emitted before key detection starts. Any fatal failure sets
the track and job to ``error`` with a §6.6 code, emits ``error``, and deletes temp files.
Blocking work (yt-dlp, key detection) runs in threads so ARQ's health check keeps
ticking; ffmpeg/ffprobe run as subprocesses.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from pitchbend_live.audio import ffmpeg
from pitchbend_live.db import repository as repo
from pitchbend_live.errors import ErrorCode, limit_message
from pitchbend_live.events import EventName, Stage, error_data, progress_data, publish
from pitchbend_live.storage import job_dir, media_path, media_url, new_media_name, publish_media
from pitchbend_live.storage import remove_path as _remove_path
from pitchbend_live.worker.context import WorkerDeps, get_deps

logger = logging.getLogger("pitchbend_live.worker")


class IngestError(Exception):
    """A fatal, user-facing pipeline failure carrying its §6.6 code."""

    def __init__(self, code: ErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


class JobGone(Exception):
    """The job's rows were deleted or superseded mid-run (dedup recreate, expiry)."""


@dataclass(frozen=True)
class SourceAudio:
    path: Path
    title: str


class JobRun:
    """One running ingest job: its ids, staging dir, and event helpers."""

    def __init__(self, deps: WorkerDeps, job_id: str, track: repo.Track) -> None:
        self.deps = deps
        self.job_id = job_id
        self.track = track
        self.work_dir = job_dir(deps.settings, job_id)
        self.media_file: str | None = None

    @property
    def track_id(self) -> str:
        return self.track.track_id

    def log_extra(self, **fields: str) -> dict[str, str]:
        return {"job_id": self.job_id, "track_id": self.track_id, **fields}

    async def emit(self, event: EventName, data: dict[str, Any]) -> None:
        """Best effort: SQLite is authoritative and SSE rebuilds from it (ADR 0005 §7)."""
        try:
            await publish(self.deps.redis, self.job_id, event, data, ttl_s=self.deps.state_ttl_s)
        except Exception:
            logger.warning("event publish failed", extra=self.log_extra(event=event), exc_info=True)

    async def progress(self, stage: Stage, pct: int | None = None) -> None:
        await self.emit("progress", progress_data(stage, pct))


FetchSource = Callable[[JobRun], Awaitable[SourceAudio]]


async def remove_path(path: Path) -> None:
    await asyncio.to_thread(_remove_path, path)


async def run_ingest(
    ctx: dict[str, Any], job_id: str, fetch: FetchSource, *, bad_media: ErrorCode
) -> None:
    """Run one ingest job end to end. Never raises for pipeline failures.

    ``bad_media`` is the code for audio ffmpeg can't handle: ``UNSUPPORTED_FILE`` for
    uploads (the user's file), ``INTERNAL`` for YouTube downloads.
    """
    deps = get_deps(ctx)
    track = await deps.db.run(repo.start_job, job_id)
    if track is None:
        logger.info("job skipped: not queued", extra={"job_id": job_id, "event": "job_skipped"})
        return
    run = JobRun(deps, job_id, track)
    logger.info("job started", extra=run.log_extra(event="job_started"))
    try:
        await asyncio.to_thread(run.work_dir.mkdir, mode=0o750, parents=True, exist_ok=True)
        await run.progress("fetching")
        source = await fetch(run)
        await finish(run, source, bad_media=bad_media)
    except JobGone:
        logger.info("job superseded", extra=run.log_extra(event="job_superseded"))
        if run.media_file:
            await remove_path(media_path(deps.settings, run.media_file))
    except IngestError as exc:
        await fail(run, exc.code)
    except asyncio.CancelledError:
        # ARQ's job_timeout or a worker shutdown: record the failure, then propagate.
        await fail(run, ErrorCode.INTERNAL)
        raise
    except Exception:
        logger.exception("job crashed", extra=run.log_extra(event="job_crashed"))
        await fail(run, ErrorCode.INTERNAL)
    finally:
        await remove_path(run.work_dir)


async def fail(run: JobRun, code: ErrorCode) -> None:
    settings = run.deps.settings
    stale_media: set[str] = {run.media_file} if run.media_file else set()
    try:
        old = await run.deps.db.run(repo.fail_ingest, run.job_id, run.track_id, code.value)
        if old:
            stale_media.add(old)
    except Exception:
        logger.exception("could not record job failure", extra=run.log_extra(code=code.value))
    for name in stale_media:
        await remove_path(media_path(settings, name))
    message = limit_message(
        code, max_upload_mb=settings.MAX_UPLOAD_MB, max_duration_s=settings.MAX_DURATION_S
    )
    await run.emit("error", error_data(code, message))
    logger.warning("job failed", extra=run.log_extra(event="job_failed", code=code.value))


async def finish(run: JobRun, source: SourceAudio, *, bad_media: ErrorCode) -> None:
    deps, settings = run.deps, run.deps.settings
    await run.progress("processing")
    out = run.work_dir / "audio.m4a"
    try:
        probed = await ffmpeg.probe(source.path)
        if not probed.has_audio:
            raise IngestError(bad_media)
        await ffmpeg.normalize_to_m4a(source.path, out, probed)
        duration = (await ffmpeg.probe(out)).duration_s
    except ffmpeg.FFmpegError:
        raise IngestError(bad_media) from None
    if duration is None or duration <= 0:
        raise IngestError(bad_media)
    if duration > settings.MAX_DURATION_S:
        raise IngestError(ErrorCode.VIDEO_TOO_LONG)
    duration = round(duration, 2)

    media_file = new_media_name()
    dest = media_path(settings, media_file)
    await asyncio.to_thread(publish_media, out, dest)
    run.media_file = media_file
    if not await deps.db.run(
        repo.mark_track_ready, run.track_id, media_file, duration, source.title
    ):
        raise JobGone
    audio_ready = {
        "track_id": run.track_id,
        "audio_url": media_url(settings, media_file),
        "duration_s": duration,
        "title": source.title,
    }
    await run.emit("audio_ready", audio_ready)
    logger.info("audio ready", extra=run.log_extra(event="audio_ready"))

    # Only now does analysis start (§6.5): the player is usable before the key is known.
    await run.progress("analyzing")
    await analyze_key(run, dest)

    if not await deps.db.run(repo.finish_job, run.job_id):
        logger.warning("job row changed before done", extra=run.log_extra(event="done"))
    await run.emit("done", {})
    logger.info("job done", extra=run.log_extra(event="done"))


async def analyze_key(run: JobRun, path: Path) -> None:
    """Key detection; any failure is non-fatal KEY_DETECTION_FAILED (§6.5, CLAUDE.md §6)."""
    db = run.deps.db
    try:
        # Imported lazily: librosa is heavy and the api process must never load it.
        from pitchbend_live.audio import key_detection

        result = await asyncio.to_thread(key_detection.detect_key, path)
        key = cast(dict[str, Any], result.to_dict())
    except Exception:
        code = ErrorCode.KEY_DETECTION_FAILED
        logger.warning(
            "key detection failed",
            extra=run.log_extra(event="key_failed", code=code.value),
            exc_info=True,
        )
        if not await db.run(repo.mark_key_failed, run.track_id):
            raise JobGone from None
        await run.emit("error", error_data(code))
        return
    if not await db.run(repo.save_key, run.track_id, key):
        raise JobGone
    await run.emit("key_ready", key)
    logger.info("key ready", extra=run.log_extra(event="key_ready"))
