"""``cleanup`` cron, hourly and at worker startup (§10 A7, ADR 0005 §10, CLAUDE.md §4).

1. Stale jobs (queued/running longer than ``STALE_JOB_S``) are closed so SSE clients
   and dedup stop waiting on a dead worker.
2. Tracks past ``expires_at`` lose their rows and media files (24 h retention).
3. Orphaned files in ``MEDIA_DIR`` (no track row) are deleted after a grace period.
4. ``TMP_DIR`` entries older than 1 hour are deleted (the ``.cache`` dir is kept).
"""

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any

from pitchbend_live.clock import now_ts, ts_after
from pitchbend_live.db import repository as repo
from pitchbend_live.errors import ErrorCode
from pitchbend_live.events import error_data, publish
from pitchbend_live.storage import CACHE_DIR_NAME, media_path, remove_path
from pitchbend_live.worker.context import WorkerDeps, get_deps
from pitchbend_live.worker.pipeline import remove_path as remove_path_async

logger = logging.getLogger("pitchbend_live.worker")

TMP_MAX_AGE_S = 3600
# A job moves its file into MEDIA_DIR just before recording it; don't race it.
ORPHAN_GRACE_S = 600


def remove_orphans(media_dir: Path, referenced: set[str], *, grace_s: float, now: float) -> int:
    removed = 0
    with os.scandir(media_dir) as entries:
        for entry in entries:
            if entry.name in referenced:
                continue
            try:
                if now - entry.stat(follow_symlinks=False).st_mtime < grace_s:
                    continue
            except FileNotFoundError:
                continue
            remove_path(Path(entry.path))
            removed += 1
    return removed


def remove_old_tmp(tmp_dir: Path, *, max_age_s: float, now: float) -> int:
    removed = 0
    with os.scandir(tmp_dir) as entries:
        for entry in entries:
            if entry.name == CACHE_DIR_NAME:
                continue
            try:
                if now - entry.stat(follow_symlinks=False).st_mtime < max_age_s:
                    continue
            except FileNotFoundError:
                continue
            remove_path(Path(entry.path))
            removed += 1
    return removed


async def _close_stale_jobs(deps: WorkerDeps, now: str) -> int:
    stale = await deps.db.run(repo.resolve_stale_jobs, ts_after(now, seconds=-repo.STALE_JOB_S))
    for job in stale:
        extra = {"job_id": job.job_id, "track_id": job.track_id, "event": "job_stale"}
        try:
            if job.playable:
                code = ErrorCode.KEY_DETECTION_FAILED
                await publish(
                    deps.redis, job.job_id, "error", error_data(code), ttl_s=deps.state_ttl_s
                )
                await publish(deps.redis, job.job_id, "done", {}, ttl_s=deps.state_ttl_s)
            else:
                code = ErrorCode.INTERNAL
                await publish(
                    deps.redis, job.job_id, "error", error_data(code), ttl_s=deps.state_ttl_s
                )
        except Exception:
            logger.warning("stale job event publish failed", extra=extra, exc_info=True)
        if job.media_file:
            await remove_path_async(media_path(deps.settings, job.media_file))
        logger.warning("closed stale job", extra={**extra, "code": code.value})
    return len(stale)


async def cleanup(ctx: dict[str, Any]) -> dict[str, int]:
    """ARQ cron task. Returns counts (ARQ logs them; no ids or names)."""
    deps = get_deps(ctx)
    settings = deps.settings
    now = now_ts()

    stale = await _close_stale_jobs(deps, now)

    expired_files = await deps.db.run(repo.delete_expired, now)
    for name in expired_files:
        await remove_path_async(media_path(settings, name))

    referenced = await deps.db.run(repo.referenced_media)
    orphans = await asyncio.to_thread(
        remove_orphans,
        Path(settings.MEDIA_DIR),
        referenced,
        grace_s=ORPHAN_GRACE_S,
        now=time.time(),
    )
    tmp = await asyncio.to_thread(
        remove_old_tmp, Path(settings.TMP_DIR), max_age_s=TMP_MAX_AGE_S, now=time.time()
    )
    counts = {"stale_jobs": stale, "expired": len(expired_files), "orphans": orphans, "tmp": tmp}
    logger.info(
        "cleanup: {stale_jobs} stale jobs, {expired} expired tracks, {orphans} orphaned files,"
        " {tmp} temp entries removed".format(**counts),
        extra={"event": "cleanup"},
    )
    return counts
