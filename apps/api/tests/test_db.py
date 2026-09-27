"""SQLite layer: connection pragmas, migrations, and the repository (§6.7, ADR 0005 §4, §14)."""

import sqlite3
import threading
import uuid
from pathlib import Path

import pytest

from keyshift.clock import ts_after
from keyshift.db import Database
from keyshift.db import repository as repo
from keyshift.db.connection import connect, transaction
from keyshift.db.migrate import Migration, apply_migrations, discover, split_statements

NOW = "2026-09-26T12:00:00Z"
STALE_BEFORE = ts_after(NOW, seconds=-repo.STALE_JOB_S)

# §6.7 verbatim: (name, type, notnull, pk)
TRACK_COLUMNS = [
    ("track_id", "TEXT", 0, 1),
    ("source_key", "TEXT", 1, 0),
    ("source", "TEXT", 1, 0),
    ("title", "TEXT", 0, 0),
    ("duration_s", "REAL", 0, 0),
    ("status", "TEXT", 1, 0),
    ("media_file", "TEXT", 0, 0),
    ("key_tonic", "TEXT", 0, 0),
    ("key_mode", "TEXT", 0, 0),
    ("key_confidence", "REAL", 0, 0),
    ("key_alternates", "TEXT", 0, 0),
    ("tuning_cents", "INTEGER", 0, 0),
    ("error_code", "TEXT", 0, 0),
    ("created_at", "TEXT", 1, 0),
    ("expires_at", "TEXT", 1, 0),
]
JOB_COLUMNS = [
    ("job_id", "TEXT", 0, 1),
    ("track_id", "TEXT", 1, 0),
    ("kind", "TEXT", 1, 0),
    ("status", "TEXT", 1, 0),
    ("created_at", "TEXT", 1, 0),
]


def columns(conn: sqlite3.Connection, table: str) -> list[tuple[str, str, int, int]]:
    return [
        (r["name"], r["type"], r["notnull"], r["pk"])
        for r in conn.execute(f"PRAGMA table_info({table})")
    ]


@pytest.fixture
def conn(db: Database) -> sqlite3.Connection:
    return connect(db.path)


def create(
    conn: sqlite3.Connection,
    source_key: str = "yt:dQw4w9WgXcQ",
    *,
    now: str = NOW,
    ttl_hours: float = 24,
    source: repo.Source = "youtube",
    title: str | None = None,
) -> repo.DedupResult:
    return repo.find_or_create_ingest(
        conn,
        source_key=source_key,
        source=source,
        title=title,
        duration_s=None,
        now=now,
        ttl_hours=ttl_hours,
        stale_before=ts_after(now, seconds=-repo.STALE_JOB_S),
        new_track_id=str(uuid.uuid4()),
        new_job_id=str(uuid.uuid4()),
    )


def make_ready(conn: sqlite3.Connection, result: repo.DedupResult, media: str = "m.m4a") -> None:
    assert repo.start_job(conn, result.job_id) is not None
    assert repo.mark_track_ready(conn, result.track_id, media, 12.5, "Song")


# --- connection ---------------------------------------------------------------------


def test_connection_pragmas(conn: sqlite3.Connection) -> None:
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_transaction_rolls_back_on_error(conn: sqlite3.Connection) -> None:
    with pytest.raises(RuntimeError), transaction(conn):
        conn.execute("INSERT INTO schema_migrations VALUES ('9999', 'x', 'y')")
        raise RuntimeError
    assert conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == 1


def test_foreign_keys_are_enforced(conn: sqlite3.Connection) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO jobs VALUES ('j', 'missing-track', 'ingest', 'queued', ?)", (NOW,)
        )


# --- migrations ---------------------------------------------------------------------


def test_schema_matches_contract(conn: sqlite3.Connection) -> None:
    assert columns(conn, "tracks") == TRACK_COLUMNS
    assert columns(conn, "jobs") == JOB_COLUMNS
    indexes = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    assert {"idx_tracks_expires_at", "idx_jobs_track_id"} <= indexes
    unique = [
        r for r in conn.execute("PRAGMA index_list(tracks)") if r["unique"] and r["origin"] == "u"
    ]
    assert len(unique) == 1  # source_key UNIQUE
    fks = list(conn.execute("PRAGMA foreign_key_list(jobs)"))
    assert [(f["table"], f["from"], f["to"]) for f in fks] == [("tracks", "track_id", "track_id")]


def test_source_check_constraint(conn: sqlite3.Connection) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO tracks (track_id, source_key, source, status, created_at, expires_at)"
            " VALUES ('t', 'k', 'vimeo', 'queued', ?, ?)",
            (NOW, NOW),
        )


def test_migrations_are_recorded_and_idempotent(tmp_path: Path) -> None:
    path = str(tmp_path / "fresh.db")
    assert apply_migrations(path) == ["0001"]
    assert apply_migrations(path) == []
    assert apply_migrations(path) == []
    with connect(path) as c:
        rows = c.execute("SELECT version, name FROM schema_migrations").fetchall()
    assert [(r["version"], r["name"]) for r in rows] == [("0001", "init")]


def test_concurrent_migrations_apply_exactly_once(tmp_path: Path) -> None:
    path = str(tmp_path / "race.db")
    barrier = threading.Barrier(8)
    results: list[list[str]] = []
    errors: list[BaseException] = []

    def migrate() -> None:
        barrier.wait()
        try:
            results.append(apply_migrations(path))
        except BaseException as exc:  # pragma: no cover - the assertion reports it
            errors.append(exc)

    threads = [threading.Thread(target=migrate) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert sorted(results, key=len) == [[]] * 7 + [["0001"]]
    with connect(path) as c:
        assert c.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == 1


def test_later_migrations_apply_in_order_and_failures_roll_back(tmp_path: Path) -> None:
    path = str(tmp_path / "multi.db")
    base = discover()
    extra = [
        Migration("0002", "add_thing", "CREATE TABLE thing (id INTEGER);\n-- trailing comment\n"),
        Migration("0003", "broken", "CREATE TABLE ok (id INTEGER);\nCREATE TABLE ok (id INTEGER);"),
    ]
    with pytest.raises(sqlite3.OperationalError):
        apply_migrations(path, base + extra)
    # All-or-nothing: nothing from the failed run is committed.
    with connect(path) as c:
        assert c.execute("SELECT name FROM sqlite_master WHERE name='tracks'").fetchone() is None

    assert apply_migrations(path, [*base, extra[0]]) == ["0001", "0002"]
    with connect(path) as c:
        assert c.execute("SELECT name FROM sqlite_master WHERE name='thing'").fetchone()


def test_discover_finds_shipped_migrations() -> None:
    migrations = discover()
    assert [m.version for m in migrations] == ["0001"]
    assert "CREATE TABLE tracks" in migrations[0].sql


def test_discover_rejects_duplicate_versions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pkg = tmp_path / "dupmigs"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "0001_a.sql").write_text("SELECT 1;")
    (pkg / "0001_b.sql").write_text("SELECT 1;")
    (pkg / "README.txt").write_text("ignored")
    monkeypatch.syspath_prepend(str(tmp_path))
    with pytest.raises(RuntimeError, match="duplicate"):
        discover("dupmigs")


def test_split_statements_handles_semicolons_in_strings_and_comments() -> None:
    sql = (
        "-- header; with a semicolon\n"
        "CREATE TABLE a (x TEXT DEFAULT 'a;b');\n"
        "\n"
        "INSERT INTO a VALUES ('c;d'); INSERT INTO a VALUES ('e');\n"
        "-- footer\n"
    )
    assert split_statements(sql) == [
        "-- header; with a semicolon\nCREATE TABLE a (x TEXT DEFAULT 'a;b');",
        "INSERT INTO a VALUES ('c;d'); INSERT INTO a VALUES ('e');",
    ]


def test_split_statements_skips_empty_statements() -> None:
    assert split_statements("CREATE TABLE a (x);\n;\n  ;\n") == ["CREATE TABLE a (x);"]


def test_split_statements_rejects_incomplete_sql() -> None:
    with pytest.raises(ValueError, match="incomplete"):
        split_statements("CREATE TABLE x (a TEXT")


# --- repository: dedup (ADR 0005 §4) ------------------------------------------------


def test_create_new_track_and_job(conn: sqlite3.Connection) -> None:
    result = create(conn, title="T")
    assert result.kind is repo.DedupKind.CREATED
    track = repo.get_track(conn, result.track_id)
    job = repo.get_job(conn, result.job_id)
    assert track is not None and job is not None
    assert (track.status, track.source, track.title) == ("queued", "youtube", "T")
    assert (track.created_at, track.expires_at) == (NOW, "2026-09-27T12:00:00Z")
    assert (job.kind, job.status, job.track_id) == ("ingest", "queued", result.track_id)


def test_in_flight_track_is_joined(conn: sqlite3.Connection) -> None:
    first = create(conn)
    again = create(conn)
    assert again.kind is repo.DedupKind.JOINED
    assert (again.job_id, again.track_id) == (first.job_id, first.track_id)
    repo.start_job(conn, first.job_id)  # fetching
    assert create(conn).kind is repo.DedupKind.JOINED


def test_ready_and_done_is_a_cache_hit(conn: sqlite3.Connection) -> None:
    first = create(conn)
    make_ready(conn, first)
    # Ready but still analyzing: join so the client gets key_ready over SSE.
    assert create(conn).kind is repo.DedupKind.JOINED
    repo.finish_job(conn, first.job_id)
    hit = create(conn)
    assert hit.kind is repo.DedupKind.HIT
    assert (hit.job_id, hit.track_id) == (first.job_id, first.track_id)


def test_error_track_is_recreated(conn: sqlite3.Connection) -> None:
    first = create(conn)
    make_ready(conn, first, media="old.m4a")
    assert repo.fail_ingest(conn, first.job_id, first.track_id, "INTERNAL") == "old.m4a"
    again = create(conn)
    assert again.kind is repo.DedupKind.CREATED
    assert again.track_id != first.track_id
    assert repo.get_track(conn, first.track_id) is None
    assert repo.get_job(conn, first.job_id) is None


def test_expired_track_is_recreated_and_old_media_reported(conn: sqlite3.Connection) -> None:
    first = create(conn, ttl_hours=1)
    make_ready(conn, first, media="old.m4a")
    repo.finish_job(conn, first.job_id)
    later = ts_after(NOW, hours=2)
    again = create(conn, now=later)
    assert again.kind is repo.DedupKind.CREATED
    assert again.replaced_media_file == "old.m4a"
    assert repo.get_track(conn, first.track_id) is None


def test_stale_in_flight_job_is_recreated(conn: sqlite3.Connection) -> None:
    first = create(conn)
    later = ts_after(NOW, seconds=repo.STALE_JOB_S + 1)
    again = create(conn, now=later)
    assert again.kind is repo.DedupKind.CREATED
    assert again.track_id != first.track_id


def test_stale_ready_analysis_is_a_hit(conn: sqlite3.Connection) -> None:
    first = create(conn)
    make_ready(conn, first)  # job still running, but long ago
    later = ts_after(NOW, seconds=repo.STALE_JOB_S + 1)
    assert create(conn, now=later).kind is repo.DedupKind.HIT


def test_track_without_job_is_recreated(conn: sqlite3.Connection) -> None:
    first = create(conn)
    conn.execute("DELETE FROM jobs WHERE job_id = ?", (first.job_id,))
    assert create(conn).kind is repo.DedupKind.CREATED


def test_join_found_under_the_write_lock(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A concurrent creator can win between the fast path and the transaction."""
    winner = create(conn)
    calls = {"n": 0}
    real = repo.get_track_by_source_key

    def racing(c: sqlite3.Connection, key: str) -> repo.Track | None:
        calls["n"] += 1
        return None if calls["n"] == 1 else real(c, key)

    monkeypatch.setattr(repo, "get_track_by_source_key", racing)
    result = create(conn)
    assert result.kind is repo.DedupKind.JOINED
    assert result.job_id == winner.job_id


# --- repository: lifecycle ----------------------------------------------------------


def test_start_job_claims_once(conn: sqlite3.Connection) -> None:
    result = create(conn)
    track = repo.start_job(conn, result.job_id)
    assert track is not None and track.status == "fetching"
    assert repo.get_job(conn, result.job_id).status == "running"  # type: ignore[union-attr]
    assert repo.start_job(conn, result.job_id) is None
    assert repo.start_job(conn, str(uuid.uuid4())) is None


def test_metadata_ready_key_and_done(conn: sqlite3.Connection) -> None:
    result = create(conn)
    repo.start_job(conn, result.job_id)
    assert repo.update_track_metadata(conn, result.track_id, "Title", 99.0)
    assert repo.update_track_metadata(conn, result.track_id, "Title 2", None)
    track = repo.get_track(conn, result.track_id)
    assert track is not None and (track.title, track.duration_s) == ("Title 2", 99.0)

    assert repo.mark_track_ready(conn, result.track_id, "abc.m4a", 98.5, "Final")
    key = {
        "tonic": "G",
        "mode": "major",
        "confidence": 0.82,
        "alternates": [{"tonic": "E", "mode": "minor", "confidence": 0.71}],
        "tuning_cents": -12,
    }
    assert repo.save_key(conn, result.track_id, key)
    assert repo.finish_job(conn, result.job_id)
    track = repo.get_track(conn, result.track_id)
    assert track is not None
    assert track.key() == key
    assert (track.status, track.media_file, track.duration_s) == ("ready", "abc.m4a", 98.5)
    assert repo.get_job(conn, result.job_id).status == "done"  # type: ignore[union-attr]
    assert repo.finish_job(conn, result.job_id) is False


def test_key_failure_is_recorded_on_a_ready_track(conn: sqlite3.Connection) -> None:
    result = create(conn)
    make_ready(conn, result)
    assert repo.mark_key_failed(conn, result.track_id)
    track = repo.get_track(conn, result.track_id)
    assert track is not None
    assert (track.status, track.error_code, track.key()) == ("ready", "KEY_DETECTION_FAILED", None)


def test_updates_report_missing_rows(conn: sqlite3.Connection) -> None:
    missing = str(uuid.uuid4())
    assert not repo.update_track_metadata(conn, missing, "t", None)
    assert not repo.mark_track_ready(conn, missing, "m.m4a", 1.0, "t")
    assert not repo.save_key(
        conn, missing, {"tonic": "C", "mode": "major", "confidence": 1, "tuning_cents": 0}
    )
    assert not repo.mark_key_failed(conn, missing)
    assert repo.fail_ingest(conn, missing, missing, "INTERNAL") is None
    assert repo.get_job_and_track(conn, missing) is None


def test_get_job_and_track(conn: sqlite3.Connection) -> None:
    result = create(conn)
    found = repo.get_job_and_track(conn, result.job_id)
    assert found is not None
    assert (found[0].job_id, found[1].track_id) == (result.job_id, result.track_id)


def test_latest_job_prefers_newest(conn: sqlite3.Connection) -> None:
    result = create(conn)
    conn.execute(
        "INSERT INTO jobs VALUES ('newer', ?, 'ingest', 'done', ?)",
        (result.track_id, ts_after(NOW, seconds=5)),
    )
    job = repo.latest_job(conn, result.track_id)
    assert job is not None and job.job_id == "newer"


def test_delete_expired_and_referenced_media(conn: sqlite3.Connection) -> None:
    old = create(conn, "yt:aaaaaaaaaaa", ttl_hours=1)
    make_ready(conn, old, media="old.m4a")
    keep = create(conn, "yt:bbbbbbbbbbb", ttl_hours=48)
    make_ready(conn, keep, media="keep.m4a")
    queued = create(conn, "up:0123456789abcdef", ttl_hours=1, source="upload")

    assert repo.referenced_media(conn) == {"old.m4a", "keep.m4a"}
    removed = repo.delete_expired(conn, ts_after(NOW, hours=2))
    assert removed == ["old.m4a"]
    assert repo.get_track(conn, old.track_id) is None
    assert repo.get_track(conn, queued.track_id) is None
    assert repo.get_job(conn, queued.job_id) is None
    assert repo.get_track(conn, keep.track_id) is not None
    assert repo.referenced_media(conn) == {"keep.m4a"}


def test_resolve_stale_jobs(conn: sqlite3.Connection) -> None:
    dead = create(conn, "yt:aaaaaaaaaaa")
    repo.start_job(conn, dead.job_id)
    analyzing = create(conn, "yt:bbbbbbbbbbb")
    make_ready(conn, analyzing, media="a.m4a")
    keyed = create(conn, "yt:ccccccccccc")
    make_ready(conn, keyed, media="k.m4a")
    repo.save_key(
        conn,
        keyed.track_id,
        {"tonic": "C", "mode": "major", "confidence": 1.0, "alternates": [], "tuning_cents": 0},
    )
    fresh = create(conn, "yt:ddddddddddd", now=ts_after(NOW, seconds=60))

    stale_before = ts_after(NOW, seconds=30)
    resolved = {s.job_id: s for s in repo.resolve_stale_jobs(conn, stale_before)}

    assert set(resolved) == {dead.job_id, analyzing.job_id, keyed.job_id}
    assert resolved[dead.job_id].playable is False
    assert resolved[analyzing.job_id].playable is True
    dead_track = repo.get_track(conn, dead.track_id)
    assert dead_track is not None and (dead_track.status, dead_track.error_code) == (
        "error",
        "INTERNAL",
    )
    playable = repo.get_track(conn, analyzing.track_id)
    assert playable is not None
    assert (playable.status, playable.error_code) == ("ready", "KEY_DETECTION_FAILED")
    keyed_track = repo.get_track(conn, keyed.track_id)
    assert keyed_track is not None and keyed_track.error_code is None
    assert repo.get_job(conn, fresh.job_id).status == "queued"  # type: ignore[union-attr]


async def test_database_runs_calls_in_a_thread(db: Database) -> None:
    main = threading.get_ident()

    def where(conn: sqlite3.Connection, value: int) -> tuple[int, int]:
        return threading.get_ident(), value

    ident, value = await db.run(where, 7)
    assert value == 7 and ident != main


pytestmark = pytest.mark.anyio


def test_wal_switch_retries_while_locked(monkeypatch: pytest.MonkeyPatch) -> None:
    from keyshift.db import connection

    class Conn:
        def __init__(self, failures: int, message: str = "database is locked") -> None:
            self.failures = failures
            self.message = message
            self.statements: list[str] = []

        def execute(self, sql: str) -> "Conn":
            self.statements.append(sql)
            if self.failures:
                self.failures -= 1
                raise sqlite3.OperationalError(self.message)
            return self

        def fetchone(self) -> tuple[str]:
            return ("delete",)

    monkeypatch.setattr(connection.time, "sleep", lambda s: None)
    conn = Conn(failures=3)
    connection._ensure_wal(conn)  # type: ignore[arg-type]
    assert conn.statements[-1] == "PRAGMA journal_mode = WAL"

    with pytest.raises(sqlite3.OperationalError, match="disk"):
        connection._ensure_wal(Conn(failures=1, message="disk I/O error"))  # type: ignore[arg-type]

    monkeypatch.setattr(connection, "BUSY_TIMEOUT_MS", 0)
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        connection._ensure_wal(Conn(failures=10**6))  # type: ignore[arg-type]
