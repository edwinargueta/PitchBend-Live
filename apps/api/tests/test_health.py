import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from keyshift.routes import health


def tick(n: int) -> str:
    return f'event: tick\ndata: {{"n": {n}}}\n\n'


def parse_sse(body: str) -> list[dict[str, str]]:
    events: list[dict[str, str]] = []
    for block in body.split("\n\n"):
        if not block:
            continue
        fields: dict[str, str] = {}
        for line in block.split("\n"):
            name, _, value = line.partition(": ")
            fields[name] = value
        events.append(fields)
    return events


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Replace the tick delay with a recorder so tests don't wait 4 s."""
    calls: list[float] = []

    async def fake_sleep(delay: float) -> None:
        calls.append(delay)

    monkeypatch.setattr(health, "_sleep", fake_sleep)
    return calls


def test_health_reports_git_sha(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_SHA", "abc1234")

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "abc1234"}


def test_health_version_defaults_to_dev(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("GIT_SHA", raising=False)

    assert client.get("/api/health").json() == {"status": "ok", "version": "dev"}


def test_stream_sends_five_ticks_one_second_apart(client: TestClient, sleeps: list[float]) -> None:
    with client.stream("GET", "/api/health/stream") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "no-cache"
        assert response.headers["x-accel-buffering"] == "no"
        body = response.read().decode()

    assert body == "".join(tick(n) for n in range(1, 6))
    events = parse_sse(body)
    assert [e["event"] for e in events] == ["tick"] * 5
    assert [json.loads(e["data"]) for e in events] == [{"n": n} for n in range(1, 6)]
    assert sleeps == [1.0] * 4


def test_each_tick_is_yielded_before_the_next_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ticks must be produced incrementally, not accumulated and sent at the end."""
    log: list[str] = []

    async def fake_sleep(delay: float) -> None:
        log.append(f"sleep {delay}")

    monkeypatch.setattr(health, "_sleep", fake_sleep)

    async def consume() -> None:
        async for chunk in health.tick_events():
            log.append(chunk)

    asyncio.run(consume())

    assert log == [
        tick(1),
        "sleep 1.0",
        tick(2),
        "sleep 1.0",
        tick(3),
        "sleep 1.0",
        tick(4),
        "sleep 1.0",
        tick(5),
    ]
