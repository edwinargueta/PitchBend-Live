import shutil
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import fakeredis
import pytest
from fastapi.testclient import TestClient

from keyshift.audio.ffmpeg import ProbeResult
from keyshift.db import Database
from keyshift.db.migrate import apply_migrations
from keyshift.main import create_app
from keyshift.ratelimit import RateDecision
from keyshift.services import Services
from keyshift.settings import Settings, get_settings
from keyshift.storage import ensure_dirs

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
requires_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not installed")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def _isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Every test gets its own data dirs, and get_settings() re-reads the environment."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "data" / "db" / "keyshift.db"))
    monkeypatch.setenv("MEDIA_DIR", str(tmp_path / "data" / "media"))
    monkeypatch.setenv("TMP_DIR", str(tmp_path / "data" / "tmp"))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def settings() -> Settings:
    return get_settings()


@pytest.fixture
def db(settings: Settings) -> Database:
    ensure_dirs(settings)
    apply_migrations(settings.DB_PATH)
    return Database(settings.DB_PATH)


@pytest.fixture
def redis_server() -> fakeredis.FakeServer:
    return fakeredis.FakeServer()


@pytest.fixture
def aredis(redis_server: fakeredis.FakeServer) -> fakeredis.FakeAsyncRedis:
    return fakeredis.FakeAsyncRedis(server=redis_server)


@pytest.fixture
def sync_redis(redis_server: fakeredis.FakeServer) -> fakeredis.FakeRedis:
    """Inspect Valkey state from test code while the app uses its own async client."""
    return fakeredis.FakeRedis(server=redis_server)


@dataclass
class FakeQueue:
    calls: list[tuple[str, str]] = field(default_factory=list)
    fail: bool = False

    async def enqueue(self, function: str, job_id: str) -> None:
        if self.fail:
            raise ConnectionError("valkey down")
        self.calls.append((function, job_id))


@dataclass
class FakeLimiter:
    """Allows ``remaining`` more requests, then denies with ``retry_after_s``."""

    remaining: int = 1_000_000
    retry_after_s: int = 42
    clients: list[str] = field(default_factory=list)

    async def acquire(self, client: str) -> RateDecision:
        self.clients.append(client)
        if self.remaining <= 0:
            return RateDecision(False, self.retry_after_s)
        self.remaining -= 1
        return RateDecision(True, 0)


@dataclass
class FakeProbe:
    result: ProbeResult = field(
        default_factory=lambda: ProbeResult(frozenset({"mp3"}), 180.0, ("mp3",), False)
    )
    error: Exception | None = None
    paths: list[Path] = field(default_factory=list)

    async def __call__(self, path: Path) -> ProbeResult:
        self.paths.append(path)
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture
def queue() -> FakeQueue:
    return FakeQueue()


@pytest.fixture
def limiter() -> FakeLimiter:
    return FakeLimiter()


@pytest.fixture
def probe() -> FakeProbe:
    return FakeProbe()


@pytest.fixture
def services(
    settings: Settings,
    redis_server: fakeredis.FakeServer,
    queue: FakeQueue,
    limiter: FakeLimiter,
    probe: FakeProbe,
) -> Services:
    return Services(
        settings=settings,
        db=Database(settings.DB_PATH),
        redis=fakeredis.FakeAsyncRedis(server=redis_server),
        queue=queue,
        limiter=limiter,
        probe=probe,
    )


@pytest.fixture
def client(services: Services) -> Iterator[TestClient]:
    with TestClient(create_app(services)) as test_client:
        yield test_client
