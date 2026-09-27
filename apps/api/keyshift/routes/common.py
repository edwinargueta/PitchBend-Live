"""Helpers shared by the jobs and uploads routes: services, rate limiting, dedup+enqueue."""

import asyncio
import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated, Any, Literal, cast

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from keyshift.clock import now_ts, ts_after
from keyshift.db import repository as repo
from keyshift.errors import ApiError, ErrorCode
from keyshift.services import Services
from keyshift.storage import job_dir, media_path, remove_path

logger = logging.getLogger(__name__)

# Canonical lowercase UUIDv4, as we generate them (§6.3). Anything else is NOT_FOUND.
_UUID4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def get_services(request: Request) -> Services:
    return cast(Services, request.app.state.services)


ServicesDep = Annotated[Services, Depends(get_services)]


def is_uuid4(value: str) -> bool:
    return _UUID4.fullmatch(value) is not None


def client_key(request: Request) -> str:
    """The rate-limit identity: ``request.client.host``, which uvicorn's
    ``--proxy-headers`` sets from the trusted X-Forwarded-For (CLAUDE.md §5). Never logged."""
    return request.client.host if request.client and request.client.host else "unknown"


async def enforce_rate_limit(services: Services, request: Request) -> None:
    decision = await services.limiter.acquire(client_key(request))
    if not decision.allowed:
        seconds = decision.retry_after_s
        raise ApiError(
            ErrorCode.RATE_LIMITED,
            f"Too many requests. Try again in {seconds} seconds.",
            retry_after_s=seconds,
        )


class JobAccepted(BaseModel):
    job_id: str
    track_id: str
    status: Literal["done", "queued"]


def _accepted(result: repo.DedupResult, status_code: int) -> JSONResponse:
    status: Literal["done", "queued"] = "done" if status_code == 200 else "queued"
    body = JobAccepted(job_id=result.job_id, track_id=result.track_id, status=status)
    return JSONResponse(body.model_dump(), status_code=status_code)


async def ingest(
    services: Services,
    *,
    source_key: str,
    source: repo.Source,
    title: str | None,
    duration_s: float | None,
    function: str,
    stage: Callable[[str], Awaitable[Any]] | None = None,
) -> JSONResponse:
    """Dedup by ``source_key`` (ADR 0005 §4), then enqueue a new job if one was created.

    200 ``done`` for a cache hit (no enqueue), 202 ``queued`` for a join or a new job.
    ``stage(job_id)`` runs before the enqueue (uploads move their temp file into place).
    """
    settings = services.settings
    now = now_ts()
    result = await services.db.run(
        repo.find_or_create_ingest,
        source_key=source_key,
        source=source,
        title=title,
        duration_s=duration_s,
        now=now,
        ttl_hours=settings.MEDIA_TTL_HOURS,
        stale_before=ts_after(now, seconds=-repo.STALE_JOB_S),
        new_track_id=str(uuid.uuid4()),
        new_job_id=str(uuid.uuid4()),
    )
    log_extra = {"job_id": result.job_id, "track_id": result.track_id}
    if result.replaced_media_file:
        await asyncio.to_thread(remove_path, media_path(settings, result.replaced_media_file))

    if result.kind is repo.DedupKind.HIT:
        logger.info("cache hit", extra={**log_extra, "event": "cache_hit"})
        return _accepted(result, 200)
    if result.kind is repo.DedupKind.JOINED:
        logger.info("joined in-flight job", extra={**log_extra, "event": "job_joined"})
        return _accepted(result, 202)

    try:
        if stage is not None:
            await stage(result.job_id)
        await services.queue.enqueue(function, result.job_id)
    except Exception:
        logger.exception("enqueue failed", extra={**log_extra, "event": "enqueue_failed"})
        await asyncio.to_thread(remove_path, job_dir(settings, result.job_id))
        await services.db.run(
            repo.fail_ingest, result.job_id, result.track_id, ErrorCode.INTERNAL.value
        )
        raise ApiError(ErrorCode.INTERNAL) from None
    logger.info("job created", extra={**log_extra, "event": "job_created"})
    return _accepted(result, 202)
