"""Health endpoints (§6.4) and the Phase 0 SSE buffering probe."""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from keyshift.settings import Settings, get_settings

router = APIRouter(tags=["health"])

TICK_COUNT = 5
TICK_INTERVAL_S = 1.0

# Indirection so tests can replace the delay without patching asyncio globally.
_sleep = asyncio.sleep


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str


@router.get("/health")
async def health(settings: Annotated[Settings, Depends(get_settings)]) -> HealthResponse:
    return HealthResponse(status="ok", version=settings.GIT_SHA)


async def tick_events() -> AsyncIterator[str]:
    """Yield ``TICK_COUNT`` SSE ``tick`` events, ``TICK_INTERVAL_S`` apart.

    Each event is yielded as its own chunk, so uvicorn writes it to the socket
    immediately; any delay a client sees comes from buffering in front of the API.
    """
    for n in range(1, TICK_COUNT + 1):
        if n > 1:
            await _sleep(TICK_INTERVAL_S)
        yield f"event: tick\ndata: {json.dumps({'n': n})}\n\n"


@router.get("/health/stream")
async def health_stream() -> StreamingResponse:
    """Prove the Ingress doesn't buffer SSE: ticks must arrive ~1 s apart, not at the end."""
    return StreamingResponse(
        tick_events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
