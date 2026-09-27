import asyncio
import importlib
import inspect

import pytest
from arq.connections import RedisSettings
from arq.worker import Worker

import keyshift.worker as worker
from keyshift.settings import get_settings


def test_worker_settings_attributes() -> None:
    settings = get_settings()
    expected_redis = RedisSettings.from_dsn(settings.REDIS_URL)
    ws = worker.WorkerSettings

    assert ws.functions == [worker.noop]
    assert ws.max_jobs == settings.WORKER_CONCURRENCY
    assert ws.health_check_interval == 30
    assert (ws.redis_settings.host, ws.redis_settings.port, ws.redis_settings.database) == (
        expected_redis.host,
        expected_redis.port,
        expected_redis.database,
    )


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


def test_noop_task_does_nothing() -> None:
    assert asyncio.run(worker.noop({})) is None
