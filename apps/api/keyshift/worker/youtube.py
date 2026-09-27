"""``fetch_youtube``: probe and download with yt-dlp as a library (§10 A3, ADR 0005 §15).

yt-dlp only ever sees the rebuilt ``https://www.youtube.com/watch?v=<id>``. It probes
first (``extract_info(download=False)``) so livestreams and over-long videos are
rejected before any download, then downloads ``bestaudio[ext=m4a]/bestaudio`` into
``TMP_DIR/<job_id>/`` reusing the probed info (no second extraction). No cookies are
ever configured (CLAUDE.md §2). yt-dlp's own output is silenced: its messages embed
URLs and titles, which must never be logged.

Option names verified against the installed yt-dlp 2026.8.19 (``YoutubeDL.__init__``
docstring and ``_clean_js_runtimes``): ``js_runtimes`` is ``{runtime: {"path": ...}}``
and defaults to ``{"deno": {}}``; the ``deno`` wheel from ``yt-dlp[deno]`` puts the
binary in the venv, located via ``deno.find_deno_bin()``. The challenge-solver scripts
come from the bundled ``yt-dlp-ejs`` package, so ``remote_components`` stays empty
(nothing is fetched and run from the network).
"""

import asyncio
import concurrent.futures
import logging
import math
import time
from pathlib import Path
from typing import Any

import yt_dlp  # type: ignore[import-untyped]
from yt_dlp.utils import (  # type: ignore[import-untyped]
    DownloadError,
    ExtractorError,
    GeoRestrictedError,
)

from keyshift.db import repository as repo
from keyshift.errors import ErrorCode
from keyshift.events import ProgressThrottle, progress_data, publish
from keyshift.logs import SilentYtDlpLogger
from keyshift.settings import Settings
from keyshift.storage import cache_dir
from keyshift.titles import sanitize_title
from keyshift.worker.pipeline import IngestError, JobGone, JobRun, SourceAudio, run_ingest
from keyshift.youtube import video_id_from_source_key, watch_url

logger = logging.getLogger("keyshift.worker")

# Patchable in tests (a fake YoutubeDL; no real YouTube in tests).
YoutubeDL: Any = yt_dlp.YoutubeDL

AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio"
LIVE_STATUSES = frozenset({"is_live", "is_upcoming", "post_live"})

# Matched against the lowercased yt-dlp message with the video id removed, in this order.
_BLOCKED_HINTS = (
    "not a bot",
    "captcha",
    "rate-limit",
    "rate limit",
    "too many requests",
    "http error 429",
    "http error 403",
    "403: forbidden",
    "being blocked",
    "try again later",
    "po token",
)
_LIVE_HINTS = ("live event will begin", "this live event", "is a live stream")
_UNAVAILABLE_HINTS = (
    "private video",
    "video is private",
    "unavailable",
    "not available",
    "no longer available",
    "removed",
    "deleted",
    "terminated",
    "does not exist",
    "your country",
    "geo restriction",
    "your location",
    "confirm your age",
    "age-restricted",
    "age restricted",
    "inappropriate",
    "members-only",
    "members only",
    "join this channel",
    "copyright",
    "premieres in",
)


def deno_runtime() -> dict[str, dict[str, str]]:
    """``js_runtimes`` pointing at the Deno binary the ``yt-dlp[deno]`` extra installed."""
    try:
        from deno import find_deno_bin  # type: ignore[import-untyped]

        return {"deno": {"path": str(find_deno_bin())}}
    except (ImportError, FileNotFoundError):
        return {"deno": {}}  # yt-dlp's default: look for "deno" in the venv/PATH


def ydl_params(settings: Settings, work_dir: Path, hook: Any) -> dict[str, Any]:
    return {
        "format": AUDIO_FORMAT,
        "noplaylist": True,
        "paths": {"home": str(work_dir), "temp": str(work_dir)},
        "outtmpl": {"default": "source.%(ext)s"},  # never the title: filenames stay neutral
        "overwrites": True,
        "updatetime": False,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": SilentYtDlpLogger(),
        "progress_hooks": [hook],
        "js_runtimes": deno_runtime(),
        "cachedir": str(cache_dir(settings, "yt-dlp")),
        "socket_timeout": 30,
    }


def map_ytdlp_error(exc: BaseException, video_id: str) -> ErrorCode:
    """yt-dlp failure -> §6.6 code. Unknown failures count as blocked: fetching from
    YouTube failed, and the actionable advice is the same (upload the file instead)."""
    original = getattr(exc, "exc_info", None)
    if isinstance(exc, GeoRestrictedError) or (
        isinstance(original, tuple)
        and len(original) > 1
        and isinstance(original[1], GeoRestrictedError)
    ):
        return ErrorCode.SOURCE_UNAVAILABLE
    message = str(exc).replace(video_id, "").lower()
    if any(hint in message for hint in _BLOCKED_HINTS):
        return ErrorCode.SOURCE_BLOCKED
    if any(hint in message for hint in _LIVE_HINTS):
        return ErrorCode.LIVESTREAM
    if any(hint in message for hint in _UNAVAILABLE_HINTS):
        return ErrorCode.SOURCE_UNAVAILABLE
    return ErrorCode.SOURCE_BLOCKED


def check_info(info: Any, max_duration_s: int) -> dict[str, Any]:
    """Reject what we won't download: livestreams and videos over ``MAX_DURATION_S``."""
    if not isinstance(info, dict) or info.get("_type", "video") != "video":
        raise IngestError(ErrorCode.SOURCE_UNAVAILABLE)
    if info.get("is_live") or info.get("live_status") in LIVE_STATUSES:
        raise IngestError(ErrorCode.LIVESTREAM)
    duration = info.get("duration")
    if isinstance(duration, int | float) and duration > max_duration_s:
        raise IngestError(ErrorCode.VIDEO_TOO_LONG)
    return info


def _duration(info: dict[str, Any]) -> float | None:
    value = info.get("duration")
    if isinstance(value, int | float) and math.isfinite(value) and value > 0:
        return float(value)
    return None


def _download(ydl: Any, info: dict[str, Any], work_dir: Path) -> Path:
    """Blocking: download the probed video's audio and return the file (thread only)."""
    result = ydl.process_ie_result(info, download=True)
    root = work_dir.resolve()
    for item in (result or {}).get("requested_downloads") or []:
        filepath = item.get("filepath") if isinstance(item, dict) else None
        if filepath:
            path = Path(filepath).resolve()
            if path.is_file() and path.is_relative_to(root):
                return path
    for path in sorted(work_dir.glob("source.*")):
        if path.is_file() and path.suffix not in (".part", ".ytdl"):
            return path
    raise IngestError(ErrorCode.INTERNAL)


class DownloadProgress:
    """yt-dlp progress hook -> throttled ``progress`` events.

    The hook runs in yt-dlp's thread; publishing is scheduled onto the event loop, and
    ``drain()`` waits for those publishes so they can't land after later events.
    """

    def __init__(self, run: JobRun, loop: asyncio.AbstractEventLoop) -> None:
        self._run = run
        self._loop = loop
        self._throttle = ProgressThrottle()
        self._pending: list[concurrent.futures.Future[None]] = []

    def hook(self, status: dict[str, Any]) -> None:
        state = status.get("status")
        if state == "finished":
            pct: int | None = 100
        elif state == "downloading":
            done = status.get("downloaded_bytes")
            total = status.get("total_bytes") or status.get("total_bytes_estimate")
            pct = None
            if isinstance(done, int | float) and isinstance(total, int | float) and total > 0:
                pct = max(0, min(100, int(done * 100 / total)))
        else:
            return
        if not self._throttle.should_emit("fetching", pct, time.monotonic()):
            return
        coro = publish(
            self._run.deps.redis,
            self._run.job_id,
            "progress",
            progress_data("fetching", pct),
            ttl_s=self._run.deps.state_ttl_s,
        )
        self._pending.append(asyncio.run_coroutine_threadsafe(coro, self._loop))

    async def drain(self) -> None:
        pending, self._pending = self._pending, []
        wrapped = [asyncio.wrap_future(f) for f in pending]
        for result in await asyncio.gather(*wrapped, return_exceptions=True):
            if isinstance(result, BaseException):
                logger.warning(
                    "progress publish failed", extra=self._run.log_extra(event="progress")
                )


async def youtube_source(run: JobRun) -> SourceAudio:
    settings = run.deps.settings
    try:
        video_id = video_id_from_source_key(run.track.source_key)
    except ValueError:
        raise IngestError(ErrorCode.INTERNAL) from None
    progress = DownloadProgress(run, asyncio.get_running_loop())
    ydl = await asyncio.to_thread(YoutubeDL, ydl_params(settings, run.work_dir, progress.hook))
    try:
        info = check_info(
            await asyncio.to_thread(ydl.extract_info, watch_url(video_id), download=False),
            settings.MAX_DURATION_S,
        )
        title = sanitize_title(info.get("title"))
        if not await run.deps.db.run(
            repo.update_track_metadata, run.track_id, title, _duration(info)
        ):
            raise JobGone
        path = await asyncio.to_thread(_download, ydl, info, run.work_dir)
    except (DownloadError, ExtractorError) as exc:
        raise IngestError(map_ytdlp_error(exc, video_id)) from None
    finally:
        await progress.drain()
        await asyncio.to_thread(ydl.close)
    return SourceAudio(path, title)


async def fetch_youtube(ctx: dict[str, Any], job_id: str) -> None:
    """ARQ task: ingest a YouTube job created by ``POST /api/jobs``."""
    await run_ingest(ctx, job_id, youtube_source, bad_media=ErrorCode.INTERNAL)
