"""ARQ worker settings (``arq keyshift.worker.WorkerSettings``).

Phase 0: a no-op worker that connects to Valkey and records ARQ's health-check key, so
``arq --check keyshift.worker.WorkerSettings`` can serve as the Kubernetes exec probe.
Importing this module only parses ``REDIS_URL``; it never opens a connection.
"""

from typing import Any, ClassVar

from arq.connections import RedisSettings

from keyshift.settings import get_settings


async def noop(ctx: dict[str, Any]) -> None:
    """Placeholder task: ARQ refuses to start a worker with no functions registered."""


_settings = get_settings()


class WorkerSettings:
    functions: ClassVar[list[Any]] = [noop]
    redis_settings: ClassVar[RedisSettings] = RedisSettings.from_dsn(_settings.REDIS_URL)
    max_jobs: ClassVar[int] = _settings.WORKER_CONCURRENCY
    # ARQ's default is 3600 s. `arq --check` passes only while the health key (TTL =
    # interval + 1 s) exists, so the interval must be shorter than the probe period.
    health_check_interval: ClassVar[int] = 30
