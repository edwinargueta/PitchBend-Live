"""SQLite connections (ADR 0005 §14): WAL, ``busy_timeout=5000``, foreign keys on.

Connections are opened in autocommit mode (``isolation_level=None``) so transactions
are explicit: ``with transaction(conn):`` runs ``BEGIN IMMEDIATE`` ... ``COMMIT``, taking
the write lock up front. The api and the worker both write, and SQLite allows one writer;
``BEGIN IMMEDIATE`` plus the busy timeout serializes them instead of failing mid-way.
"""

import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager

BUSY_TIMEOUT_MS = 5000


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(
        db_path,
        timeout=BUSY_TIMEOUT_MS / 1000,
        isolation_level=None,
        check_same_thread=True,
    )
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    _ensure_wal(conn)
    conn.execute("PRAGMA synchronous = NORMAL")  # durable enough in WAL mode, fewer fsyncs
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_wal(conn: sqlite3.Connection) -> None:
    """Switch to WAL (persistent, so normally a no-op read).

    Switching needs an exclusive lock and SQLite skips the busy handler for it, so when
    the api and worker open a fresh database at the same moment one of them gets
    "database is locked" at once; retry until the busy timeout instead.
    """
    deadline = time.monotonic() + BUSY_TIMEOUT_MS / 1000
    while True:
        try:
            mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
            if str(mode).lower() != "wal":
                conn.execute("PRAGMA journal_mode = WAL")
            return
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc) or time.monotonic() >= deadline:
                raise
            time.sleep(0.01)


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """``BEGIN IMMEDIATE`` ... ``COMMIT``, rolling back on any exception."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
