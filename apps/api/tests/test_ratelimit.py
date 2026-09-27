"""Token bucket (§10 A2, ADR 0005 §2).

The Lua script needs a server that runs Lua. fakeredis only does with the optional
``lupa`` package (``fakeredis[lua]``), which isn't a dependency yet; set
``PITCHBEND_LIVE_TEST_REDIS_URL`` to run these against a real Valkey instead. The HTTP-level
behavior (429 body, Retry-After, ordering) is covered with a stub limiter in the route
tests, and the script's arithmetic is mirrored and checked below without a server.
"""

import importlib.util
import math
import os
import uuid
from collections.abc import AsyncIterator

import fakeredis
import pytest
from redis.asyncio import Redis

from pitchbend_live.ratelimit import TOKEN_BUCKET_LUA, RateDecision, TokenBucketLimiter

pytestmark = pytest.mark.anyio

HAS_LUPA = importlib.util.find_spec("lupa") is not None
REAL_REDIS_URL = os.environ.get("PITCHBEND_LIVE_TEST_REDIS_URL")


@pytest.fixture(params=["fakeredis-lua", "valkey"])
async def lua_redis(request: pytest.FixtureRequest) -> AsyncIterator[Redis]:
    if request.param == "fakeredis-lua":
        if not HAS_LUPA:
            pytest.skip("fakeredis needs the optional 'lupa' package for Lua scripts")
        client: Redis = fakeredis.FakeAsyncRedis()
    else:
        if not REAL_REDIS_URL:
            pytest.skip("set PITCHBEND_LIVE_TEST_REDIS_URL to test the Lua script on Valkey")
        client = Redis.from_url(REAL_REDIS_URL)
    yield client
    await client.aclose()


class Clock:
    def __init__(self, now: float = 1_800_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def limiter(redis: Redis, clock: Clock, capacity: int = 10) -> TokenBucketLimiter:
    return TokenBucketLimiter(redis, capacity, clock=clock, prefix=f"test:{uuid.uuid4()}:")


async def test_bucket_allows_capacity_then_denies(lua_redis: Redis) -> None:
    clock = Clock()
    bucket = limiter(lua_redis, clock)
    decisions = [await bucket.acquire("1.2.3.4") for _ in range(10)]
    assert all(d.allowed for d in decisions)
    denied = await bucket.acquire("1.2.3.4")
    assert denied == RateDecision(False, 360)  # one token per 6 minutes


async def test_bucket_refills_continuously(lua_redis: Redis) -> None:
    clock = Clock()
    bucket = limiter(lua_redis, clock)
    for _ in range(10):
        await bucket.acquire("ip")
    clock.now += 180  # half a token
    half = await bucket.acquire("ip")
    assert half == RateDecision(False, 180)
    clock.now += 180
    assert (await bucket.acquire("ip")).allowed
    assert not (await bucket.acquire("ip")).allowed


async def test_bucket_never_exceeds_capacity(lua_redis: Redis) -> None:
    clock = Clock()
    bucket = limiter(lua_redis, clock, capacity=3)
    clock.now += 10 * 3600
    assert [(await bucket.acquire("ip")).allowed for _ in range(4)] == [True, True, True, False]


async def test_buckets_are_per_client(lua_redis: Redis) -> None:
    clock = Clock()
    bucket = limiter(lua_redis, clock, capacity=1)
    assert (await bucket.acquire("a")).allowed
    assert not (await bucket.acquire("a")).allowed
    assert (await bucket.acquire("b")).allowed


async def test_bucket_key_expires(lua_redis: Redis) -> None:
    clock = Clock()
    bucket = limiter(lua_redis, clock)
    await bucket.acquire("ip")
    keys = [k async for k in lua_redis.scan_iter(match=f"{bucket._prefix}*")]
    assert len(keys) == 1
    ttl_ms = await lua_redis.pttl(keys[0])
    assert 0 < ttl_ms <= 360_000 + 1000


def test_capacity_must_be_positive() -> None:
    with pytest.raises(ValueError):
        TokenBucketLimiter(fakeredis.FakeAsyncRedis(), 0)


async def test_limiter_passes_expected_arguments() -> None:
    """Without a Lua-capable server: check the call shape and the decision mapping."""
    calls: list[tuple[list[str], list[object]]] = []
    replies = iter([[1, 0], [0, 1], [0, 179_001]])

    class FakeScript:
        async def __call__(self, keys: list[str], args: list[object]) -> list[int]:
            calls.append((keys, args))
            return next(replies)

    class FakeRedis:
        def register_script(self, script: str) -> FakeScript:
            assert script == TOKEN_BUCKET_LUA
            return FakeScript()

    bucket = TokenBucketLimiter(FakeRedis(), 10, clock=Clock(1000.5))  # type: ignore[arg-type]
    assert await bucket.acquire("9.9.9.9") == RateDecision(True, 0)
    assert await bucket.acquire("9.9.9.9") == RateDecision(False, 1)  # rounds up, min 1
    assert await bucket.acquire("9.9.9.9") == RateDecision(False, 180)
    keys, args = calls[0]
    assert keys == ["ratelimit:9.9.9.9"]
    assert args[0] == 10
    assert math.isclose(float(str(args[1])), 10 / 3_600_000)
    assert args[2] == 1_000_500


def reference_bucket(
    state: dict[str, float] | None, capacity: float, rate: float, now: float
) -> tuple[dict[str, float], int, int]:
    """A line-for-line Python mirror of TOKEN_BUCKET_LUA, to pin down its arithmetic."""
    tokens, ts = (capacity, now) if state is None else (state["tokens"], state["ts"])
    elapsed = max(0.0, now - ts)
    tokens = min(capacity, tokens + elapsed * rate)
    if tokens >= 1:
        return {"tokens": tokens - 1, "ts": now}, 1, 0
    return {"tokens": tokens, "ts": now}, 0, math.ceil((1 - tokens) / rate)


def test_reference_arithmetic_matches_documented_behavior() -> None:
    rate = 10 / 3_600_000
    state = None
    for i in range(10):
        state, allowed, _ = reference_bucket(state, 10, rate, 1000.0 + i)
        assert allowed == 1
    state, allowed, retry = reference_bucket(state, 10, rate, 1010.0)
    assert (allowed, math.ceil(retry / 1000)) == (0, 360)
    # A clock step backwards never mints tokens.
    state, allowed, _ = reference_bucket(state, 10, rate, 0.0)
    assert allowed == 0
    assert "math.min(capacity" in TOKEN_BUCKET_LUA and "if elapsed < 0" in TOKEN_BUCKET_LUA
