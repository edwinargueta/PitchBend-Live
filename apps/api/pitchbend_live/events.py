"""Job events: Valkey pub/sub + replayable state -> SSE (ARCHITECTURE.md §6.5, ADR 0005 §7-9).

The worker calls ``publish``: it updates ``job_state:<id>`` (a JSON document with a TTL of
``MEDIA_TTL_HOURS``) and PUBLISHes the event on ``job:<id>`` in one MULTI/EXEC, state
first, so a subscriber can never miss an event between replay and live delivery.

``stream_job_events`` serves one SSE connection: subscribe first, then read the state
(falling back to SQLite if Valkey lost it), replay it in order (progress -> audio_ready
-> key_ready or error -> done), then relay live events with a ``: ping`` every
``ping_interval`` seconds. It ends after ``done`` or a fatal ``error``.
Duplicate events are harmless: clients treat events idempotently (ADR 0005 §8).
"""

import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

import anyio
from redis.asyncio import Redis
from redis.exceptions import WatchError

from pitchbend_live.db import Database
from pitchbend_live.db import repository as repo
from pitchbend_live.errors import NON_FATAL, ErrorCode, default_message
from pitchbend_live.settings import Settings
from pitchbend_live.storage import media_url

logger = logging.getLogger(__name__)

EventName = Literal["progress", "audio_ready", "key_ready", "error", "done"]
Stage = Literal["queued", "fetching", "processing", "analyzing"]
State = dict[str, Any]

EVENT_NAMES: tuple[EventName, ...] = ("progress", "audio_ready", "key_ready", "error", "done")


def channel(job_id: str) -> str:
    return f"job:{job_id}"


def state_key(job_id: str) -> str:
    return f"job_state:{job_id}"


def empty_state() -> State:
    return {"progress": None, "audio_ready": None, "key_ready": None, "error": None, "done": False}


def apply_event(state: State, event: EventName, data: dict[str, Any]) -> State:
    if event == "done":
        state["done"] = True
    else:
        state[event] = data
    return state


def progress_data(stage: Stage, pct: int | None) -> dict[str, Any]:
    return {"stage": stage, "pct": pct}


def error_data(code: ErrorCode | str, message: str | None = None) -> dict[str, Any]:
    return {"code": str(code), "message": message or default_message(code)}


def is_terminal(event: str, data: dict[str, Any]) -> bool:
    return event == "done" or (event == "error" and data.get("code") not in NON_FATAL)


async def publish(
    redis: Redis, job_id: str, event: EventName, data: dict[str, Any], *, ttl_s: int
) -> None:
    """Update ``job_state:<id>`` and PUBLISH on ``job:<id>`` atomically (state first)."""
    key = state_key(job_id)
    message = json.dumps({"event": event, "data": data}, separators=(",", ":"))
    async with redis.pipeline(transaction=True) as pipe:
        while True:
            try:
                await pipe.watch(key)
                raw = await pipe.get(key)
                state = _decode_state(raw) or empty_state()
                apply_event(state, event, data)
                pipe.multi()  # type: ignore[no-untyped-call]
                pipe.set(key, json.dumps(state, separators=(",", ":")), ex=max(ttl_s, 1))
                pipe.publish(channel(job_id), message)
                await pipe.execute()
                return
            except WatchError:  # pragma: no cover - needs a concurrent writer mid-update
                continue


def _decode_state(raw: bytes | str | None) -> State | None:
    if raw is None:
        return None
    try:
        doc = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(doc, dict):
        return None
    state = empty_state()
    state.update({k: doc.get(k) for k in state})
    state["done"] = bool(state["done"])
    return state


async def read_state(redis: Redis, job_id: str) -> State | None:
    return _decode_state(await redis.get(state_key(job_id)))


def state_from_db(settings: Settings, job: repo.Job, track: repo.Track) -> State:
    """Rebuild the replay state from SQLite when ``job_state`` is gone (ADR 0005 §7)."""
    state = empty_state()
    if track.status == repo.TRACK_ERROR or job.status == repo.JOB_ERROR:
        state["error"] = error_data(track.error_code or ErrorCode.INTERNAL)
        return state
    if track.status == repo.TRACK_READY and track.media_file:
        state["audio_ready"] = audio_ready_data(settings, track, track.media_file)
        key = track.key()
        if key is not None:
            state["key_ready"] = key
        elif track.error_code == repo.KEY_DETECTION_FAILED:
            state["error"] = error_data(ErrorCode.KEY_DETECTION_FAILED)
        if job.status == repo.JOB_RUNNING:
            # Still analyzing: don't claim done; key_ready or error follows live.
            state["progress"] = progress_data("analyzing", None)
        else:
            state["done"] = True
        return state
    state["progress"] = progress_data("queued", None)
    return state


def audio_ready_data(settings: Settings, track: repo.Track, media_file: str) -> dict[str, Any]:
    return {
        "track_id": track.track_id,
        "audio_url": media_url(settings, media_file),
        "duration_s": track.duration_s,
        "title": track.title or "Untitled",
    }


def replay(state: State) -> list[tuple[str, dict[str, Any]]]:
    """Events for a late subscriber, in ADR 0005 §7 order."""
    events: list[tuple[str, dict[str, Any]]] = []
    for name in ("progress", "audio_ready", "key_ready", "error"):
        if state.get(name) is not None:
            events.append((name, state[name]))
    if state.get("done"):
        events.append(("done", {}))
    return events


def format_sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


PING = ": ping\n\n"


def _decode_message(message: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    try:
        doc = json.loads(message["data"])
        event, data = doc["event"], doc["data"]
    except (KeyError, TypeError, ValueError):
        return None
    if event not in EVENT_NAMES or not isinstance(data, dict):
        return None
    return event, data


async def stream_job_events(
    redis: Redis,
    db: Database,
    settings: Settings,
    job_id: str,
    *,
    ping_interval: float,
) -> AsyncIterator[str]:
    pubsub = redis.pubsub()
    try:
        await pubsub.subscribe(channel(job_id))  # before reading state: nothing is lost
        state = await read_state(redis, job_id)
        if state is None:
            found = await db.run(repo.get_job_and_track, job_id)
            if found is None:
                yield format_sse("error", error_data(ErrorCode.NOT_FOUND))
                return
            state = state_from_db(settings, *found)
        for event, data in replay(state):
            yield format_sse(event, data)
            if is_terminal(event, data):
                return

        next_ping = time.monotonic() + ping_interval
        while True:
            remaining = next_ping - time.monotonic()
            if remaining <= 0:
                yield PING
                next_ping = time.monotonic() + ping_interval
                continue
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=remaining)
            if message is None:
                continue
            decoded = _decode_message(message)
            if decoded is None:
                continue
            event, data = decoded
            yield format_sse(event, data)
            if is_terminal(event, data):
                return
    finally:
        # Starlette cancels this generator on disconnect; shield the cleanup awaits.
        with anyio.CancelScope(shield=True), contextlib.suppress(Exception):
            await pubsub.unsubscribe()
            await pubsub.aclose()  # type: ignore[no-untyped-call]


class ProgressThrottle:
    """Rate-limit ``progress`` events: a new stage, 100 %, a change of at least
    ``min_step`` points, or any change after ``min_interval`` seconds. Within a stage an
    unknown (``None``) percentage is dropped."""

    def __init__(self, *, min_interval: float = 1.0, min_step: int = 5) -> None:
        self.min_interval = min_interval
        self.min_step = min_step
        self._stage: str | None = None
        self._pct: int | None = None
        self._at = 0.0

    def should_emit(self, stage: str, pct: int | None, now: float) -> bool:
        changed_stage = stage != self._stage
        if not changed_stage:
            if pct is None or pct == self._pct:
                return False  # an unknown total mid-stage is not news
            big_step = self._pct is None or abs(pct - self._pct) >= self.min_step
            if not (pct == 100 or big_step or now - self._at >= self.min_interval):
                return False
        self._stage, self._pct, self._at = stage, pct, now
        return True
