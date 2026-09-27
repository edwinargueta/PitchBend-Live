"""The api's shared dependencies, built once per process in the app lifespan.

Tests build a ``Services`` with fakes (fakeredis, a recording queue, a stub limiter or
probe) and pass it to ``create_app``.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from arq.connections import ArqRedis
from redis.asyncio import ConnectionPool, Redis

from pitchbend_live.audio import ffmpeg
from pitchbend_live.db import Database
from pitchbend_live.queue import ArqQueue, JobQueue
from pitchbend_live.ratelimit import RateLimiter, TokenBucketLimiter
from pitchbend_live.settings import Settings

Probe = Callable[[Path], Awaitable[ffmpeg.ProbeResult]]


@dataclass
class Services:
    settings: Settings
    db: Database
    redis: Redis
    queue: JobQueue
    limiter: RateLimiter
    probe: Probe = ffmpeg.probe

    async def aclose(self) -> None:
        await self.redis.aclose()


def build_services(settings: Settings) -> Services:
    """Production wiring. Connects lazily, so the api starts even if Valkey is down."""
    redis = ArqRedis(ConnectionPool.from_url(settings.REDIS_URL))
    return Services(
        settings=settings,
        db=Database(settings.DB_PATH),
        redis=redis,
        queue=ArqQueue(redis),
        limiter=TokenBucketLimiter(redis, settings.RATE_LIMIT_JOBS_PER_HOUR),
    )
