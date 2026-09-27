"""Per-client-IP token bucket in Valkey (ARCHITECTURE.md §10 A2, ADR 0005 §2).

One bucket per ``request.client.host`` (uvicorn ``--proxy-headers`` sets it from the
Ingress's trusted ``X-Forwarded-For``), shared by ``POST /api/jobs`` and
``POST /api/uploads``. Capacity is ``RATE_LIMIT_JOBS_PER_HOUR``; tokens refill
continuously at ``capacity / 3600`` per second. The read-refill-take-write cycle runs
as one Lua script, so concurrent requests can't both spend the last token.

The bucket is a hash ``{tokens, ts}`` that expires once it would be full again.
"""

import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from redis.asyncio import Redis

WINDOW_S = 3600

# KEYS[1] = bucket; ARGV = capacity, refill rate (tokens/ms), now (ms).
# Returns {allowed (0|1), retry_after_ms}.
TOKEN_BUCKET_LUA = """
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
local elapsed = now - ts
if elapsed < 0 then
  elapsed = 0
end
tokens = math.min(capacity, tokens + elapsed * rate)
local allowed = 0
local retry_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_ms = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity - tokens) / rate) + 1000)
return {allowed, retry_ms}
"""


@dataclass(frozen=True)
class RateDecision:
    allowed: bool
    retry_after_s: int  # 0 when allowed; otherwise >= 1 (the Retry-After value)


class RateLimiter(Protocol):
    async def acquire(self, client: str) -> RateDecision: ...


class TokenBucketLimiter:
    def __init__(
        self,
        redis: Redis,
        capacity: int,
        *,
        window_s: float = WINDOW_S,
        clock: Callable[[], float] = time.time,
        prefix: str = "ratelimit:",
    ) -> None:
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self.capacity = capacity
        self.rate_per_ms = capacity / (window_s * 1000)
        self._clock = clock
        self._prefix = prefix
        self._script = redis.register_script(TOKEN_BUCKET_LUA)

    async def acquire(self, client: str) -> RateDecision:
        now_ms = int(self._clock() * 1000)
        allowed, retry_ms = await self._script(
            keys=[f"{self._prefix}{client}"],
            args=[self.capacity, repr(self.rate_per_ms), now_ms],
        )
        if int(allowed) == 1:
            return RateDecision(True, 0)
        return RateDecision(False, max(1, math.ceil(int(retry_ms) / 1000)))
