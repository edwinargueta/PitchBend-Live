"""``GET /api/tracks/{track_id}`` (ARCHITECTURE.md §6.4)."""

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel

from pitchbend_live.clock import now_ts
from pitchbend_live.db import repository as repo
from pitchbend_live.errors import ApiError, ErrorCode
from pitchbend_live.routes.common import ServicesDep, is_uuid4
from pitchbend_live.settings import Settings
from pitchbend_live.storage import media_url

router = APIRouter(tags=["tracks"])


class KeyCandidateOut(BaseModel):
    tonic: str
    mode: Literal["major", "minor"]
    confidence: float


class KeyOut(KeyCandidateOut):
    alternates: list[KeyCandidateOut]
    tuning_cents: int


class TrackOut(BaseModel):
    track_id: str
    source: Literal["youtube", "upload"]
    title: str | None
    duration_s: float | None
    status: Literal["queued", "fetching", "ready", "error"]
    audio_url: str | None
    key: KeyOut | None
    expires_at: str


def track_out(settings: Settings, track: repo.Track) -> dict[str, Any]:
    audio_url = None
    if track.status == repo.TRACK_READY and track.media_file:
        audio_url = media_url(settings, track.media_file)
    return {
        "track_id": track.track_id,
        "source": track.source,
        "title": track.title,
        "duration_s": track.duration_s,
        "status": track.status,
        "audio_url": audio_url,
        "key": track.key(),
        "expires_at": track.expires_at,
    }


@router.get("/tracks/{track_id}", response_model=TrackOut)
async def get_track(track_id: str, services: ServicesDep) -> dict[str, Any]:
    if not is_uuid4(track_id):
        raise ApiError(ErrorCode.NOT_FOUND)
    track = await services.db.run(repo.get_track, track_id)
    # Expired tracks are gone even before cleanup deletes them (ADR 0005 §1).
    if track is None or track.is_expired(now_ts()):
        raise ApiError(ErrorCode.NOT_FOUND)
    return track_out(services.settings, track)
