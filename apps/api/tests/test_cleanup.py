"""The cleanup cron (§10 A7): expiry with a short TTL, orphans, temp files, stale jobs."""

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import fakeredis
import pytest

from keyshift import events
from keyshift.clock import now_ts, ts_after
from keyshift.db import Database
from keyshift.db import repository as repo
from keyshift.db.connection import connect
from keyshift.settings import Settings
from keyshift.worker import cleanup as cleanup_mod
from keyshift.worker.cleanup import ORPHAN_GRACE_S, TMP_MAX_AGE_S, cleanup
from keyshift.worker.context import WorkerDeps

pytestmark = pytest.mark.anyio


def make_track(
    db: Database, settings: Settings, key: str, *, ttl_hours: float, media: str | None
) -> repo.DedupResult:
    now = now_ts()
    result = db.call(
        repo.find_or_create_ingest,
        source_key=key,
        source="youtube",
        title=None,
        duration_s=None,
        now=now,
        ttl_hours=ttl_hours,
        stale_before=ts_after(now, seconds=-repo.STALE_JOB_S),
        new_track_id=str(uuid.uuid4()),
        new_job_id=str(uuid.uuid4()),
    )
    if media:
        db.call(repo.start_job, result.job_id)
        db.call(repo.mark_track_ready, result.track_id, media, 10.0, "t")
        db.call(repo.finish_job, result.job_id)
        (Path(settings.MEDIA_DIR) / media).write_bytes(b"audio")
    return result


def age(path: Path, seconds: float) -> None:
    past = time.time() - seconds
    os.utime(path, (past, past))


@pytest.fixture
def ctx(settings: Settings, db: Database, aredis: fakeredis.FakeAsyncRedis) -> dict[str, Any]:
    return {"deps": WorkerDeps(settings=settings, db=db, redis=aredis)}


async def test_cleanup_with_a_short_ttl(
    ctx: dict[str, Any], db: Database, settings: Settings
) -> None:
    # MEDIA_TTL_HOURS=0 in effect: expires_at == created_at, so it's expired at once.
    expired = make_track(db, settings, "yt:aaaaaaaaaaa", ttl_hours=0, media="expired.m4a")
    kept = make_track(db, settings, "yt:bbbbbbbbbbb", ttl_hours=24, media="kept.m4a")

    counts = await cleanup(ctx)

    assert counts["expired"] == 1
    assert db.call(repo.get_track, expired.track_id) is None
    assert db.call(repo.get_job, expired.job_id) is None
    assert not (Path(settings.MEDIA_DIR) / "expired.m4a").exists()
    assert db.call(repo.get_track, kept.track_id) is not None
    assert (Path(settings.MEDIA_DIR) / "kept.m4a").exists()


async def test_orphans_are_removed_after_the_grace_period(
    ctx: dict[str, Any], db: Database, settings: Settings
) -> None:
    make_track(db, settings, "yt:bbbbbbbbbbb", ttl_hours=24, media="kept.m4a")
    media = Path(settings.MEDIA_DIR)
    old_orphan = media / f"{uuid.uuid4()}.m4a"
    old_orphan.write_bytes(b"x")
    age(old_orphan, ORPHAN_GRACE_S + 60)
    (media / ".half-written.tmp").write_bytes(b"x")
    age(media / ".half-written.tmp", ORPHAN_GRACE_S + 60)
    fresh_orphan = media / f"{uuid.uuid4()}.m4a"
    fresh_orphan.write_bytes(b"x")  # a job may be about to record it
    age(media / "kept.m4a", ORPHAN_GRACE_S * 10)

    counts = await cleanup(ctx)

    assert counts["orphans"] == 2
    assert sorted(os.listdir(media)) == sorted(["kept.m4a", fresh_orphan.name])


async def test_old_temp_entries_are_removed_but_cache_is_kept(
    ctx: dict[str, Any], settings: Settings
) -> None:
    tmp = Path(settings.TMP_DIR)
    old_job = tmp / str(uuid.uuid4())
    old_job.mkdir()
    (old_job / "upload").write_bytes(b"x")
    age(old_job, TMP_MAX_AGE_S + 60)
    old_part = tmp / ".upload-abc.part"
    old_part.write_bytes(b"x")
    age(old_part, TMP_MAX_AGE_S + 60)
    young = tmp / str(uuid.uuid4())
    young.mkdir()
    cache = tmp / ".cache" / "yt-dlp"
    cache.mkdir(parents=True)
    age(tmp / ".cache", TMP_MAX_AGE_S * 100)

    counts = await cleanup(ctx)

    assert counts["tmp"] == 2
    assert sorted(os.listdir(tmp)) == sorted([".cache", young.name])
    assert cache.is_dir()


async def test_stale_jobs_are_closed_with_events(
    ctx: dict[str, Any], db: Database, settings: Settings, sync_redis: fakeredis.FakeRedis
) -> None:
    long_ago = ts_after(now_ts(), seconds=-(repo.STALE_JOB_S + 60))
    conn = connect(db.path)
    dead = make_track(db, settings, "yt:ccccccccccc", ttl_hours=24, media=None)
    analyzing = make_track(db, settings, "yt:ddddddddddd", ttl_hours=24, media=None)
    db.call(repo.start_job, analyzing.job_id)
    db.call(repo.mark_track_ready, analyzing.track_id, "a.m4a", 10.0, "t")
    (Path(settings.MEDIA_DIR) / "a.m4a").write_bytes(b"audio")
    conn.execute("UPDATE jobs SET created_at = ?", (long_ago,))
    conn.execute("UPDATE tracks SET created_at = ?", (long_ago,))

    counts = await cleanup(ctx)

    assert counts["stale_jobs"] == 2
    dead_state = json.loads(sync_redis.get(events.state_key(dead.job_id)))
    assert dead_state["error"]["code"] == "INTERNAL" and not dead_state["done"]
    playable = json.loads(sync_redis.get(events.state_key(analyzing.job_id)))
    assert playable["error"]["code"] == "KEY_DETECTION_FAILED" and playable["done"]
    assert (Path(settings.MEDIA_DIR) / "a.m4a").exists()
    track = db.call(repo.get_track, analyzing.track_id)
    assert track is not None and track.status == "ready"


async def test_stale_job_media_is_deleted_and_publish_failures_tolerated(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Broken(fakeredis.FakeAsyncRedis):
        def pipeline(self, *args: Any, **kwargs: Any) -> Any:
            raise ConnectionError("down")

    ctx = {"deps": WorkerDeps(settings=settings, db=db, redis=Broken())}
    stale = [repo.StaleJob("j", "t", False, "gone.m4a")]
    monkeypatch.setattr(repo, "resolve_stale_jobs", lambda conn, before: stale)
    (Path(settings.MEDIA_DIR) / "gone.m4a").write_bytes(b"x")
    counts = await cleanup(ctx)
    assert counts["stale_jobs"] == 1
    assert not (Path(settings.MEDIA_DIR) / "gone.m4a").exists()


def test_scanners_tolerate_files_vanishing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "a").write_bytes(b"x")

    class Vanishing:
        name = "a"
        path = str(tmp_path / "a")

        def stat(self, follow_symlinks: bool = True) -> os.stat_result:
            raise FileNotFoundError

    class Scan:
        def __enter__(self) -> list[Vanishing]:
            return [Vanishing()]

        def __exit__(self, *exc: object) -> None:
            return None

    monkeypatch.setattr(cleanup_mod.os, "scandir", lambda path: Scan())
    assert cleanup_mod.remove_orphans(tmp_path, set(), grace_s=0, now=time.time()) == 0
    assert cleanup_mod.remove_old_tmp(tmp_path, max_age_s=0, now=time.time()) == 0
