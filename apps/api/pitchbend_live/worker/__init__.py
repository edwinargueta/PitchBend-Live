"""ARQ worker settings (``arq pitchbend_live.worker.WorkerSettings``, D16).

Tasks: ``fetch_youtube`` and ``ingest_upload`` (enqueued by the api with our ``job_id``
as the ARQ job id) and the ``cleanup`` cron (hourly and at startup). Startup creates
the data directories and applies migrations, like the api does.

Importing this module only parses ``REDIS_URL``; it never opens a connection, and it
never imports librosa: key detection is imported lazily (in the task and the warm-up).
"""

import asyncio
import logging
import os
from typing import Any, ClassVar

from arq.connections import RedisSettings
from arq.cron import CronJob, cron
from arq.worker import Function, func

from pitchbend_live.db import Database
from pitchbend_live.logs import configure_logging
from pitchbend_live.queue import FETCH_YOUTUBE, INGEST_UPLOAD
from pitchbend_live.settings import get_settings
from pitchbend_live.storage import cache_dir, prepare_storage
from pitchbend_live.worker import cleanup as cleanup_module
from pitchbend_live.worker.context import WorkerDeps
from pitchbend_live.worker.upload import ingest_upload
from pitchbend_live.worker.youtube import fetch_youtube

logger = logging.getLogger("pitchbend_live.worker")

# Longest single ingest: a 12-minute song's download + transcode + key detection on one
# shared OCPU. Must stay below repository.STALE_JOB_S.
JOB_TIMEOUT_S = 15 * 60
CLEANUP_TIMEOUT_S = 5 * 60


async def startup(ctx: dict[str, Any]) -> None:
    configure_logging()
    settings = get_settings()
    await prepare_storage(settings)
    # Deno (yt-dlp's JS runtime) needs a writable cache dir; the image user has no HOME.
    os.environ.setdefault("DENO_DIR", str(cache_dir(settings, "deno")))
    ctx["deps"] = WorkerDeps(settings=settings, db=Database(settings.DB_PATH), redis=ctx["redis"])
    await warm_up_key_detection()


async def warm_up_key_detection() -> None:
    """Pay numba's JIT compile (2-4 s) at startup instead of in the first job. Never fatal."""
    try:
        # Imported lazily, like in the task: librosa is heavy and the api never loads it.
        from pitchbend_live.audio.key_detection import warm_up

        await asyncio.to_thread(warm_up)
    except Exception:
        logger.warning("key detection warm-up failed", extra={"event": "startup"}, exc_info=True)


_settings = get_settings()


class WorkerSettings:
    functions: ClassVar[list[Function]] = [
        func(fetch_youtube, name=FETCH_YOUTUBE, max_tries=1),
        func(ingest_upload, name=INGEST_UPLOAD, max_tries=1),
    ]
    cron_jobs: ClassVar[list[CronJob]] = [
        cron(
            cleanup_module.cleanup,
            name="cleanup",
            minute=0,
            second=0,
            run_at_startup=True,
            timeout=CLEANUP_TIMEOUT_S,
        )
    ]
    on_startup = startup
    redis_settings: ClassVar[RedisSettings] = RedisSettings.from_dsn(_settings.REDIS_URL)
    max_jobs: ClassVar[int] = _settings.WORKER_CONCURRENCY
    job_timeout: ClassVar[int] = JOB_TIMEOUT_S
    # Failures are recorded and reported, never retried: the user resubmits instead.
    max_tries: ClassVar[int] = 1
    # ARQ's default is 3600 s. `arq --check` passes only while the health key (TTL =
    # interval + 1 s) exists, so the interval must be shorter than the probe period.
    health_check_interval: ClassVar[int] = 30
