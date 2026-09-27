"""Production wiring: lazy Valkey client, ARQ enqueue with our job id."""

from typing import Any

import pytest
from arq.connections import ArqRedis

from keyshift.queue import ArqQueue
from keyshift.ratelimit import TokenBucketLimiter
from keyshift.services import build_services
from keyshift.settings import Settings

pytestmark = pytest.mark.anyio


async def test_build_services_connects_lazily(settings: Settings) -> None:
    unreachable = settings.model_copy(update={"REDIS_URL": "redis://queue.invalid:6390/2"})
    services = build_services(unreachable)  # must not connect
    assert isinstance(services.redis, ArqRedis)
    assert isinstance(services.queue, ArqQueue)
    assert isinstance(services.limiter, TokenBucketLimiter)
    assert services.limiter.capacity == settings.RATE_LIMIT_JOBS_PER_HOUR
    assert services.db.path == settings.DB_PATH
    await services.aclose()


async def test_arq_queue_uses_job_id_as_arq_job_id() -> None:
    calls: list[tuple[Any, ...]] = []

    class FakeArq:
        async def enqueue_job(self, function: str, *args: Any, **kwargs: Any) -> None:
            calls.append((function, args, kwargs))

    await ArqQueue(FakeArq()).enqueue("fetch_youtube", "job-1")  # type: ignore[arg-type]
    assert calls == [("fetch_youtube", ("job-1",), {"_job_id": "job-1"})]
