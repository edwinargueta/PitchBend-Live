"""POST /api/jobs, GET /api/jobs/{id}/events, GET /api/tracks/{id} (§6.4-6.6, ADR 0005)."""

import json
import os
import time
import uuid

import fakeredis
import pytest
from fastapi.testclient import TestClient

from keyshift import events
from keyshift.clock import ts_after
from keyshift.db import Database
from keyshift.db import repository as repo
from keyshift.db.connection import connect
from keyshift.main import create_app
from keyshift.routes import jobs as jobs_route
from keyshift.services import Services
from tests.conftest import FakeLimiter, FakeQueue

ID = "dQw4w9WgXcQ"
URL = f"https://youtu.be/{ID}?si=tracking"


def post_job(client: TestClient, url: object = URL, **kwargs: object) -> tuple[int, dict]:  # type: ignore[type-arg]
    response = client.post("/api/jobs", json={"url": url}, **kwargs)  # type: ignore[arg-type]
    return response.status_code, response.json()


def test_cache_miss_creates_track_and_enqueues(
    client: TestClient, queue: FakeQueue, services: Services
) -> None:
    status, body = post_job(client)
    assert status == 202
    assert body["status"] == "queued"
    assert set(body) == {"job_id", "track_id", "status"}
    assert queue.calls == [("fetch_youtube", body["job_id"])]
    track = services.db.call(repo.get_track, body["track_id"])
    assert track is not None
    assert (track.source_key, track.source, track.status) == (f"yt:{ID}", "youtube", "queued")


def test_in_flight_resubmission_joins_the_same_job(client: TestClient, queue: FakeQueue) -> None:
    _, first = post_job(client)
    status, again = post_job(client, f"https://www.youtube.com/watch?v={ID}&t=5")
    assert status == 202
    assert again == first
    assert len(queue.calls) == 1


def test_cache_hit_returns_200_fast_without_enqueue(
    client: TestClient, queue: FakeQueue, services: Services
) -> None:
    _, first = post_job(client)
    conn = connect(services.db.path)
    repo.start_job(conn, first["job_id"])
    repo.mark_track_ready(conn, first["track_id"], "x.m4a", 200.0, "Song")
    repo.finish_job(conn, first["job_id"])
    queue.calls.clear()

    started = time.perf_counter()
    status, body = post_job(client)
    elapsed = time.perf_counter() - started

    assert status == 200
    assert body == {"job_id": first["job_id"], "track_id": first["track_id"], "status": "done"}
    assert "audio_url" not in body  # the client reads it from GET /api/tracks (ADR 0005 §3)
    assert queue.calls == []
    assert elapsed < 0.2


def test_error_track_is_recreated(client: TestClient, queue: FakeQueue, services: Services) -> None:
    _, first = post_job(client)
    services.db.call(repo.fail_ingest, first["job_id"], first["track_id"], "SOURCE_BLOCKED")
    status, again = post_job(client)
    assert status == 202
    assert again["track_id"] != first["track_id"]
    assert [c[1] for c in queue.calls] == [first["job_id"], again["job_id"]]


def test_expired_track_is_recreated_and_old_file_deleted(
    client: TestClient, services: Services
) -> None:
    _, first = post_job(client)
    conn = connect(services.db.path)
    repo.start_job(conn, first["job_id"])
    repo.mark_track_ready(conn, first["track_id"], "old.m4a", 200.0, "Song")
    repo.finish_job(conn, first["job_id"])
    conn.execute("UPDATE tracks SET expires_at = '2000-01-01T00:00:00Z'")
    media = services.settings.MEDIA_DIR + "/old.m4a"
    with open(media, "wb") as fh:
        fh.write(b"audio")

    status, again = post_job(client)
    assert status == 202
    assert again["track_id"] != first["track_id"]
    assert not (services.db.call(repo.get_track, first["track_id"]))
    assert not os.path.exists(media)


@pytest.mark.parametrize(
    "payload",
    [
        {"url": "https://vimeo.com/123"},
        {"url": "https://www.youtube.com/playlist?list=PL1"},
        {"url": ""},
        {"url": 12345},
        {"url": None},
        {"link": URL},
        {},
        [],
        {"url": "x" * 9000},
    ],
)
def test_invalid_url_is_400_and_costs_no_token(
    client: TestClient, limiter: FakeLimiter, queue: FakeQueue, payload: object
) -> None:
    response = client.post("/api/jobs", json=payload)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_URL"
    assert response.json()["error"]["message"]
    assert limiter.clients == []
    assert queue.calls == []


def test_malformed_json_is_invalid_url(client: TestClient) -> None:
    response = client.post(
        "/api/jobs", content=b"{not json", headers={"content-type": "application/json"}
    )
    assert response.status_code == 400
    assert response.json() == {
        "error": {"code": "INVALID_URL", "message": response.json()["error"]["message"]}
    }


def test_rate_limited_after_validation_before_dedup(
    client: TestClient, limiter: FakeLimiter, queue: FakeQueue
) -> None:
    limiter.remaining = 1
    assert post_job(client)[0] == 202
    response = client.post("/api/jobs", json={"url": URL})  # would be a join, but limited
    assert response.status_code == 429
    error = response.json()["error"]
    assert error["code"] == "RATE_LIMITED"
    assert error["retry_after_s"] == 42
    assert response.headers["retry-after"] == "42"
    assert limiter.clients == ["testclient", "testclient"]
    assert len(queue.calls) == 1


def test_cache_hits_count_against_the_limit(
    client: TestClient, limiter: FakeLimiter, services: Services
) -> None:
    _, first = post_job(client)
    services.db.call(repo.start_job, first["job_id"])
    services.db.call(repo.mark_track_ready, first["track_id"], "x.m4a", 1.0, "t")
    services.db.call(repo.finish_job, first["job_id"])
    assert post_job(client)[0] == 200
    assert len(limiter.clients) == 2


def test_enqueue_failure_is_internal_and_marks_error(
    client: TestClient, queue: FakeQueue, services: Services
) -> None:
    queue.fail = True
    response = client.post("/api/jobs", json={"url": URL})
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL"
    conn = connect(services.db.path)
    track = repo.get_track_by_source_key(conn, f"yt:{ID}")
    assert track is not None and (track.status, track.error_code) == ("error", "INTERNAL")
    # The next submission recreates instead of joining a job that will never run.
    queue.fail = False
    assert post_job(client)[0] == 202


# --- GET /api/tracks/{id} ---------------------------------------------------------------


def test_get_track_lifecycle(client: TestClient, services: Services) -> None:
    _, created = post_job(client)
    response = client.get(f"/api/tracks/{created['track_id']}")
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "track_id": created["track_id"],
        "source": "youtube",
        "title": None,
        "duration_s": None,
        "status": "queued",
        "audio_url": None,
        "key": None,
        "expires_at": body["expires_at"],
    }
    assert body["expires_at"].endswith("Z") and len(body["expires_at"]) == 20

    key = {
        "tonic": "G",
        "mode": "major",
        "confidence": 0.82,
        "alternates": [{"tonic": "E", "mode": "minor", "confidence": 0.71}],
        "tuning_cents": -12,
    }
    services.db.call(repo.start_job, created["job_id"])
    services.db.call(repo.mark_track_ready, created["track_id"], "abc.m4a", 213.4, "Song")
    services.db.call(repo.save_key, created["track_id"], key)
    body = client.get(f"/api/tracks/{created['track_id']}").json()
    assert body["status"] == "ready"
    assert body["audio_url"] == "/media/abc.m4a"
    assert body["title"] == "Song"
    assert body["duration_s"] == 213.4
    assert body["key"] == key


@pytest.mark.parametrize(
    "track_id",
    [
        str(uuid.uuid4()),  # unknown
        "not-a-uuid",
        "../../etc/passwd",
        str(uuid.uuid4()).upper(),
        "00000000-0000-1000-8000-000000000000",  # not v4
    ],
)
def test_unknown_or_malformed_track_is_404(client: TestClient, track_id: str) -> None:
    response = client.get(f"/api/tracks/{track_id}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_expired_track_is_404_before_cleanup(client: TestClient, services: Services) -> None:
    _, created = post_job(client)
    connect(services.db.path).execute(
        "UPDATE tracks SET expires_at = ?", (ts_after("2020-01-01T00:00:00Z", hours=1),)
    )
    assert client.get(f"/api/tracks/{created['track_id']}").status_code == 404
    assert client.get(f"/api/jobs/{created['job_id']}/events").status_code == 404


# --- GET /api/jobs/{id}/events ------------------------------------------------------------


def test_events_404s(client: TestClient) -> None:
    for job_id in [str(uuid.uuid4()), "nope"]:
        response = client.get(f"/api/jobs/{job_id}/events")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"


def test_events_replay_until_done(
    client: TestClient, services: Services, sync_redis: fakeredis.FakeRedis
) -> None:
    _, created = post_job(client)
    job_id = created["job_id"]
    for event, data in [
        ("progress", {"stage": "analyzing", "pct": None}),
        ("audio_ready", {"track_id": created["track_id"], "audio_url": "/media/a.m4a"}),
        ("error", events.error_data("KEY_DETECTION_FAILED")),
        ("done", {}),
    ]:
        state = (
            json.loads(sync_redis.get(events.state_key(job_id)) or "null") or events.empty_state()
        )
        events.apply_event(state, event, data)  # type: ignore[arg-type]
        sync_redis.set(events.state_key(job_id), json.dumps(state))

    with client.stream("GET", f"/api/jobs/{job_id}/events") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "no-cache"
        assert response.headers["x-accel-buffering"] == "no"
        body = response.read().decode()
    names = [line.split(": ", 1)[1] for line in body.splitlines() if line.startswith("event:")]
    assert names == ["progress", "audio_ready", "error", "done"]


def test_events_fall_back_to_sqlite_when_state_is_gone(
    client: TestClient, services: Services
) -> None:
    _, created = post_job(client)
    services.db.call(repo.fail_ingest, created["job_id"], created["track_id"], "LIVESTREAM")
    body = client.get(f"/api/jobs/{created['job_id']}/events").text
    assert body.startswith("event: error\n")
    assert '"code":"LIVESTREAM"' in body


def test_ping_interval_is_patchable(monkeypatch: pytest.MonkeyPatch) -> None:
    assert jobs_route.PING_INTERVAL_S == 15.0
    monkeypatch.setattr(jobs_route, "PING_INTERVAL_S", 0.01)
    assert jobs_route.PING_INTERVAL_S == 0.01


def test_services_are_closed_when_app_built_them(monkeypatch: pytest.MonkeyPatch) -> None:
    closed: list[bool] = []

    class Built(Services):
        async def aclose(self) -> None:
            closed.append(True)

    def build(settings: object) -> Services:
        return Built(
            settings=settings,  # type: ignore[arg-type]
            db=Database(settings.DB_PATH),  # type: ignore[attr-defined]
            redis=fakeredis.FakeAsyncRedis(),
            queue=FakeQueue(),
            limiter=FakeLimiter(),
        )

    monkeypatch.setattr("keyshift.main.build_services", build)
    with TestClient(create_app()) as c:
        assert c.get("/api/health").status_code == 200
    assert closed == [True]
