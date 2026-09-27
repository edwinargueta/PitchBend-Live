"""Job events: publish + state, replay, SQLite fallback, live relay, pings (§6.5, ADR 0005 §7-8)."""

import asyncio
import json
import sqlite3
from collections.abc import AsyncIterator

import fakeredis
import pytest

from keyshift import events
from keyshift.db import Database
from keyshift.db import repository as repo
from keyshift.db.connection import connect
from keyshift.settings import Settings
from tests.test_db import create, make_ready

pytestmark = pytest.mark.anyio

JOB = "11111111-1111-4111-8111-111111111111"
KEY = {
    "tonic": "G",
    "mode": "major",
    "confidence": 0.82,
    "alternates": [{"tonic": "E", "mode": "minor", "confidence": 0.71}],
    "tuning_cents": -12,
}


def parse(chunks: list[str]) -> list[tuple[str, dict[str, object]]]:
    parsed = []
    for chunk in chunks:
        if chunk.startswith(":"):
            parsed.append(("ping", {}))
            continue
        lines = dict(line.split(": ", 1) for line in chunk.strip().split("\n"))
        parsed.append((lines["event"], json.loads(lines["data"])))
    return parsed


async def take(stream: AsyncIterator[str], n: int) -> list[str]:
    return [await asyncio.wait_for(anext(stream), 2.0) for _ in range(n)]


async def test_publish_updates_state_then_publishes(aredis: fakeredis.FakeAsyncRedis) -> None:
    pubsub = aredis.pubsub()
    await pubsub.subscribe(events.channel(JOB))
    await events.publish(aredis, JOB, "progress", {"stage": "fetching", "pct": 5}, ttl_s=60)
    await events.publish(aredis, JOB, "audio_ready", {"track_id": "t"}, ttl_s=60)
    await events.publish(aredis, JOB, "done", {}, ttl_s=60)

    state = await events.read_state(aredis, JOB)
    assert state == {
        "progress": {"stage": "fetching", "pct": 5},
        "audio_ready": {"track_id": "t"},
        "key_ready": None,
        "error": None,
        "done": True,
    }
    ttl = await aredis.ttl(events.state_key(JOB))
    assert 0 < ttl <= 60

    received = []
    while len(received) < 3:
        message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1)
        if message:
            received.append(json.loads(message["data"]))
    assert [m["event"] for m in received] == ["progress", "audio_ready", "done"]
    assert received[0]["data"] == {"stage": "fetching", "pct": 5}
    await pubsub.aclose()


@pytest.mark.parametrize("raw", [b"not json", b"[1,2]", b'"text"'])
async def test_corrupt_state_is_ignored(aredis: fakeredis.FakeAsyncRedis, raw: bytes) -> None:
    await aredis.set(events.state_key(JOB), raw)
    assert await events.read_state(aredis, JOB) is None
    await events.publish(aredis, JOB, "done", {}, ttl_s=60)
    assert (await events.read_state(aredis, JOB))["done"] is True  # type: ignore[index]


def test_replay_order() -> None:
    state = {
        "progress": {"stage": "analyzing", "pct": None},
        "audio_ready": {"track_id": "t"},
        "key_ready": KEY,
        "error": None,
        "done": True,
    }
    assert [e for e, _ in events.replay(state)] == ["progress", "audio_ready", "key_ready", "done"]
    state["key_ready"] = None
    state["error"] = events.error_data("KEY_DETECTION_FAILED")
    assert [e for e, _ in events.replay(state)] == ["progress", "audio_ready", "error", "done"]
    assert events.replay(events.empty_state()) == []


@pytest.mark.parametrize(
    ("event", "data", "terminal"),
    [
        ("done", {}, True),
        ("error", {"code": "SOURCE_BLOCKED"}, True),
        ("error", {"code": "INTERNAL"}, True),
        ("error", {"code": "KEY_DETECTION_FAILED"}, False),
        ("progress", {"stage": "queued"}, False),
        ("audio_ready", {}, False),
        ("key_ready", KEY, False),
    ],
)
def test_is_terminal(event: str, data: dict[str, object], terminal: bool) -> None:
    assert events.is_terminal(event, data) is terminal


def test_format_sse() -> None:
    assert events.format_sse("done", {}) == "event: done\ndata: {}\n\n"
    assert events.format_sse("progress", {"stage": "queued", "pct": None}) == (
        'event: progress\ndata: {"stage":"queued","pct":null}\n\n'
    )


def test_error_data_uses_default_messages() -> None:
    data = events.error_data("SOURCE_BLOCKED")
    assert data["code"] == "SOURCE_BLOCKED"
    assert "upload" in str(data["message"]).lower()
    assert events.error_data("NOPE")["message"] == events.error_data("INTERNAL")["message"]


# --- SQLite fallback (ADR 0005 §7) --------------------------------------------------


@pytest.fixture
def conn(db: Database) -> sqlite3.Connection:
    return connect(db.path)


def fallback(settings: Settings, conn: sqlite3.Connection, job_id: str) -> events.State:
    found = repo.get_job_and_track(conn, job_id)
    assert found is not None
    return events.state_from_db(settings, *found)


def test_fallback_queued(settings: Settings, conn: sqlite3.Connection) -> None:
    result = create(conn)
    assert events.replay(fallback(settings, conn, result.job_id)) == [
        ("progress", {"stage": "queued", "pct": None})
    ]
    repo.start_job(conn, result.job_id)  # fetching still replays as queued (ADR 0005 §7)
    assert events.replay(fallback(settings, conn, result.job_id))[0][0] == "progress"


def test_fallback_ready_with_key(settings: Settings, conn: sqlite3.Connection) -> None:
    result = create(conn)
    make_ready(conn, result, media="abc.m4a")
    repo.save_key(conn, result.track_id, KEY)
    repo.finish_job(conn, result.job_id)
    replayed = events.replay(fallback(settings, conn, result.job_id))
    assert replayed == [
        (
            "audio_ready",
            {
                "track_id": result.track_id,
                "audio_url": "/media/abc.m4a",
                "duration_s": 12.5,
                "title": "Song",
            },
        ),
        ("key_ready", KEY),
        ("done", {}),
    ]


def test_fallback_ready_key_failed(settings: Settings, conn: sqlite3.Connection) -> None:
    result = create(conn)
    make_ready(conn, result)
    repo.mark_key_failed(conn, result.track_id)
    repo.finish_job(conn, result.job_id)
    replayed = events.replay(fallback(settings, conn, result.job_id))
    assert [e for e, _ in replayed] == ["audio_ready", "error", "done"]
    assert replayed[1][1]["code"] == "KEY_DETECTION_FAILED"


def test_fallback_ready_still_analyzing(settings: Settings, conn: sqlite3.Connection) -> None:
    result = create(conn)
    make_ready(conn, result)
    replayed = events.replay(fallback(settings, conn, result.job_id))
    assert [e for e, _ in replayed] == ["progress", "audio_ready"]
    assert replayed[0][1] == {"stage": "analyzing", "pct": None}


def test_fallback_error(settings: Settings, conn: sqlite3.Connection) -> None:
    result = create(conn)
    repo.fail_ingest(conn, result.job_id, result.track_id, "SOURCE_BLOCKED")
    replayed = events.replay(fallback(settings, conn, result.job_id))
    assert [(e, d["code"]) for e, d in replayed] == [("error", "SOURCE_BLOCKED")]


# --- the SSE generator ----------------------------------------------------------------


def stream(
    aredis: fakeredis.FakeAsyncRedis, db: Database, settings: Settings, job_id: str, ping: float
) -> AsyncIterator[str]:
    return events.stream_job_events(aredis, db, settings, job_id, ping_interval=ping)


async def test_stream_replays_state_then_ends_on_done(
    aredis: fakeredis.FakeAsyncRedis, db: Database, settings: Settings
) -> None:
    for event, data in [
        ("progress", {"stage": "analyzing", "pct": None}),
        ("audio_ready", {"track_id": "t"}),
        ("key_ready", KEY),
        ("done", {}),
    ]:
        await events.publish(aredis, JOB, event, data, ttl_s=60)  # type: ignore[arg-type]
    chunks = [c async for c in stream(aredis, db, settings, JOB, 5)]
    assert [e for e, _ in parse(chunks)] == ["progress", "audio_ready", "key_ready", "done"]


async def test_stream_relays_live_events_and_pings(
    aredis: fakeredis.FakeAsyncRedis, db: Database, settings: Settings
) -> None:
    await events.publish(aredis, JOB, "progress", {"stage": "queued", "pct": None}, ttl_s=60)
    gen = stream(aredis, db, settings, JOB, 0.2)
    assert parse(await take(gen, 1)) == [("progress", {"stage": "queued", "pct": None})]

    # Nothing happens: a ping arrives.
    assert await take(gen, 1) == [": ping\n\n"]

    async def later() -> None:
        await asyncio.sleep(0.05)
        await events.publish(aredis, JOB, "progress", {"stage": "fetching", "pct": 40}, ttl_s=60)
        await events.publish(aredis, JOB, "audio_ready", {"track_id": "t"}, ttl_s=60)
        await events.publish(
            aredis, JOB, "error", events.error_data("KEY_DETECTION_FAILED"), ttl_s=60
        )
        await events.publish(aredis, JOB, "done", {}, ttl_s=60)

    task = asyncio.create_task(later())
    rest = [c async for c in gen]
    await task
    names = [e for e, _ in parse(rest) if e != "ping"]
    # KEY_DETECTION_FAILED is non-fatal: the stream continues until done.
    assert names == ["progress", "audio_ready", "error", "done"]


async def test_stream_ends_on_fatal_live_error(
    aredis: fakeredis.FakeAsyncRedis, db: Database, settings: Settings
) -> None:
    await events.publish(aredis, JOB, "progress", {"stage": "fetching", "pct": 0}, ttl_s=60)
    gen = stream(aredis, db, settings, JOB, 5)
    await take(gen, 1)
    await events.publish(aredis, JOB, "error", events.error_data("SOURCE_BLOCKED"), ttl_s=60)
    rest = [c async for c in gen]
    assert [(e, d.get("code")) for e, d in parse(rest)] == [("error", "SOURCE_BLOCKED")]


async def test_stream_ends_on_replayed_fatal_error(
    aredis: fakeredis.FakeAsyncRedis, db: Database, settings: Settings
) -> None:
    await events.publish(aredis, JOB, "progress", {"stage": "fetching", "pct": 10}, ttl_s=60)
    await events.publish(aredis, JOB, "error", events.error_data("LIVESTREAM"), ttl_s=60)
    chunks = [c async for c in stream(aredis, db, settings, JOB, 5)]
    assert [e for e, _ in parse(chunks)] == ["progress", "error"]


async def test_stream_skips_malformed_live_messages(
    aredis: fakeredis.FakeAsyncRedis, db: Database, settings: Settings
) -> None:
    await events.publish(aredis, JOB, "progress", {"stage": "queued", "pct": None}, ttl_s=60)
    gen = stream(aredis, db, settings, JOB, 5)
    await take(gen, 1)
    for bad in ["nope", json.dumps({"event": "evil", "data": {}}), json.dumps({"event": "done"})]:
        await aredis.publish(events.channel(JOB), bad)
    await aredis.publish(events.channel(JOB), json.dumps({"event": "done", "data": {}}))
    assert [e for e, _ in parse([c async for c in gen])] == ["done"]


async def test_stream_falls_back_to_sqlite(
    aredis: fakeredis.FakeAsyncRedis, db: Database, settings: Settings
) -> None:
    conn = connect(db.path)
    result = create(conn)
    repo.fail_ingest(conn, result.job_id, result.track_id, "SOURCE_UNAVAILABLE")
    chunks = [c async for c in stream(aredis, db, settings, result.job_id, 5)]
    assert [(e, d["code"]) for e, d in parse(chunks)] == [("error", "SOURCE_UNAVAILABLE")]


async def test_stream_unknown_job_without_state(
    aredis: fakeredis.FakeAsyncRedis, db: Database, settings: Settings
) -> None:
    chunks = [c async for c in stream(aredis, db, settings, JOB, 5)]
    assert [(e, d["code"]) for e, d in parse(chunks)] == [("error", "NOT_FOUND")]


async def test_stream_closes_pubsub_when_abandoned(
    aredis: fakeredis.FakeAsyncRedis, db: Database, settings: Settings
) -> None:
    await events.publish(aredis, JOB, "progress", {"stage": "queued", "pct": None}, ttl_s=60)
    gen = stream(aredis, db, settings, JOB, 5)
    await take(gen, 1)
    assert (await aredis.pubsub_numsub(events.channel(JOB)))[0][1] == 1
    await gen.aclose()  # what Starlette does when the client disconnects
    assert (await aredis.pubsub_numsub(events.channel(JOB)))[0][1] == 0


# --- progress throttle ------------------------------------------------------------------


def test_progress_throttle() -> None:
    throttle = events.ProgressThrottle(min_interval=1.0, min_step=5)
    assert throttle.should_emit("fetching", 0, 0.0)
    assert not throttle.should_emit("fetching", 0, 0.1)  # unchanged
    assert not throttle.should_emit("fetching", 3, 0.2)  # small step, too soon
    assert throttle.should_emit("fetching", 5, 0.3)  # >= 5 points
    assert throttle.should_emit("fetching", 6, 1.4)  # >= 1 s later
    assert not throttle.should_emit("fetching", 7, 1.5)
    assert throttle.should_emit("fetching", 100, 1.6)  # completion always
    assert throttle.should_emit("processing", None, 1.7)  # new stage always
    assert not throttle.should_emit("processing", None, 1.8)
    assert throttle.should_emit("fetching", None, 1.9)
    assert throttle.should_emit("fetching", 10, 2.0)  # None -> number
