"""Dependencies the worker's startup hook puts in the ARQ ``ctx`` for every task."""

from dataclasses import dataclass
from typing import Any, cast

from redis.asyncio import Redis

from pitchbend_live.db import Database
from pitchbend_live.settings import Settings


@dataclass
class WorkerDeps:
    settings: Settings
    db: Database
    redis: Redis  # ARQ's own pool (ctx["redis"]), reused for event publishing

    @property
    def state_ttl_s(self) -> int:
        return self.settings.MEDIA_TTL_HOURS * 3600


def get_deps(ctx: dict[str, Any]) -> WorkerDeps:
    return cast(WorkerDeps, ctx["deps"])
