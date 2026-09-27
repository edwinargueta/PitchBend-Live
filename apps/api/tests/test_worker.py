import importlib
import inspect
import logging
import os
from pathlib import Path
from typing import Any

import fakeredis
import pytest
from arq.connections import RedisSettings
from arq.worker import Worker

import pitchbend_live.worker as worker
from pitchbend_live.audio import key_detection
from pitchbend_live.db import repository as repo
from pitchbend_live.db.connection import connect
from pitchbend_live.settings import get_settings
from pitchbend_live.worker.context import WorkerDeps, get_deps


def dirs_present(root: Path) -> list[Path]:
    return [p for p in root.iterdir() if p.is_dir()]


def test_worker_settings_attributes() -> None:
    settings = get_settings()
    expected_redis = RedisSettings.from_dsn(settings.REDIS_URL)
    ws = worker.WorkerSettings

    assert [f.name for f in ws.functions] == ["fetch_youtube", "ingest_upload"]
    assert [f.coroutine for f in ws.functions] == [worker.fetch_youtube, worker.ingest_upload]
    assert all(f.max_tries == 1 for f in ws.functions)
    assert ws.max_jobs == settings.WORKER_CONCURRENCY
    assert ws.health_check_interval == 30
    assert ws.max_tries == 1
    assert 0 < ws.job_timeout < repo.STALE_JOB_S
    assert ws.on_startup is worker.startup
    assert (ws.redis_settings.host, ws.redis_settings.port, ws.redis_settings.database) == (
        expected_redis.host,
        expected_redis.port,
        expected_redis.database,
    )


def test_cleanup_cron_runs_hourly_and_at_startup() -> None:
    (job,) = worker.WorkerSettings.cron_jobs
    assert job.name == "cleanup"
    assert job.coroutine is worker.cleanup_module.cleanup
    assert job.run_at_startup is True
    assert (job.minute, job.second) == (0, 0)
    assert job.hour is None  # every hour


def test_worker_settings_are_valid_arq_options() -> None:
    """ARQ silently ignores unknown attributes, so a typo would go unnoticed."""
    options = {name for name in vars(worker.WorkerSettings) if not name.startswith("_")}
    assert options <= set(inspect.signature(Worker).parameters)


def test_worker_settings_come_from_env_without_connecting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # An unresolvable host: importing must only parse the URL, never connect.
    monkeypatch.setenv("REDIS_URL", "redis://queue.invalid:6380/3")
    monkeypatch.setenv("WORKER_CONCURRENCY", "7")
    get_settings.cache_clear()
    try:
        ws = importlib.reload(worker).WorkerSettings

        assert ws.redis_settings.host == "queue.invalid"
        assert ws.redis_settings.port == 6380
        assert ws.redis_settings.database == 3
        assert ws.max_jobs == 7
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
        importlib.reload(worker)


@pytest.mark.anyio
async def test_startup_prepares_storage_and_deps(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    warmed: list[bool] = []
    monkeypatch.setattr(key_detection, "warm_up", lambda: warmed.append(True))
    monkeypatch.delenv("DENO_DIR", raising=False)
    redis = fakeredis.FakeAsyncRedis()
    ctx: dict[str, Any] = {"redis": redis}

    await worker.startup(ctx)

    settings = get_settings()
    deps = get_deps(ctx)
    assert isinstance(deps, WorkerDeps)
    assert deps.redis is redis and deps.db.path == settings.DB_PATH
    assert deps.state_ttl_s == settings.MEDIA_TTL_HOURS * 3600
    for path in (settings.MEDIA_DIR, settings.TMP_DIR, str(Path(settings.DB_PATH).parent)):
        assert path in {str(p) for p in dirs_present(Path(settings.DB_PATH).parents[1])}
    tables = {r[0] for r in connect(settings.DB_PATH).execute("SELECT name FROM sqlite_master")}
    assert {"tracks", "jobs", "schema_migrations"} <= tables
    assert os.environ["DENO_DIR"] == os.path.join(settings.TMP_DIR, ".cache", "deno")
    assert warmed == [True]


@pytest.mark.anyio
async def test_warm_up_failure_is_only_a_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def broken() -> None:
        raise RuntimeError("numba exploded")

    monkeypatch.setattr(key_detection, "warm_up", broken)
    with caplog.at_level(logging.WARNING):
        await worker.warm_up_key_detection()
    assert "warm-up failed" in caplog.text
