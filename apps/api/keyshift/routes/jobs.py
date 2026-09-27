"""``POST /api/jobs`` and ``GET /api/jobs/{job_id}/events`` (ARCHITECTURE.md §6.4-6.5)."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from keyshift.clock import now_ts
from keyshift.db import repository as repo
from keyshift.errors import ApiError, ErrorCode
from keyshift.events import stream_job_events
from keyshift.queue import FETCH_YOUTUBE
from keyshift.routes.common import JobAccepted, ServicesDep, enforce_rate_limit, ingest, is_uuid4
from keyshift.youtube import parse_youtube_url

router = APIRouter(tags=["jobs"])

# Read at request time so tests can shorten it (§6.5: a ": ping" every 15 s).
PING_INTERVAL_S = 15.0

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class JobRequest(BaseModel):
    url: str = Field(max_length=8192)


@router.post(
    "/jobs",
    status_code=202,
    response_model=JobAccepted,
    responses={200: {"model": JobAccepted, "description": "Cache hit"}},
)
async def create_job(body: JobRequest, request: Request, services: ServicesDep) -> JSONResponse:
    # Order (§10 A2, ADR 0005 §2): validate/rebuild -> rate limit -> dedup -> enqueue.
    video = parse_youtube_url(body.url)
    if video is None:
        raise ApiError(ErrorCode.INVALID_URL)
    await enforce_rate_limit(services, request)
    return await ingest(
        services,
        source_key=video.source_key,
        source="youtube",
        title=None,
        duration_s=None,
        function=FETCH_YOUTUBE,
    )


@router.get("/jobs/{job_id}/events", response_class=StreamingResponse)
async def job_events(job_id: str, services: ServicesDep) -> StreamingResponse:
    if not is_uuid4(job_id):
        raise ApiError(ErrorCode.NOT_FOUND)
    found = await services.db.run(repo.get_job_and_track, job_id)
    if found is None or found[1].is_expired(now_ts()):
        raise ApiError(ErrorCode.NOT_FOUND)
    return StreamingResponse(
        stream_job_events(
            services.redis,
            services.db,
            services.settings,
            job_id,
            ping_interval=PING_INTERVAL_S,
        ),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
