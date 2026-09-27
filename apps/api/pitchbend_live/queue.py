"""Enqueueing ARQ jobs from the api (the api never imports ``pitchbend_live.worker``).

The ARQ job id is our ``job_id``, so a repeated enqueue of the same job is a no-op.
"""

from typing import Protocol

from arq.connections import ArqRedis

FETCH_YOUTUBE = "fetch_youtube"
INGEST_UPLOAD = "ingest_upload"


class JobQueue(Protocol):
    async def enqueue(self, function: str, job_id: str) -> None: ...


class ArqQueue:
    def __init__(self, redis: ArqRedis) -> None:
        self._redis = redis

    async def enqueue(self, function: str, job_id: str) -> None:
        await self._redis.enqueue_job(function, job_id, _job_id=job_id)
