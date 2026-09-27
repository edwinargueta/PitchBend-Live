"""Versioned SQL migrations, applied at startup by both api and worker (ADR 0005 §14).

Files are ``pitchbend_live/db/migrations/NNNN_name.sql``, applied in version order and recorded
in ``schema_migrations``. The whole run happens inside one ``BEGIN IMMEDIATE``
transaction: two processes starting together serialize on SQLite's write lock, and the
second one sees the first one's rows and applies nothing. A failing migration rolls back
completely. (``executescript`` can't be used: it commits before it starts.)
"""

import re
import sqlite3
from dataclasses import dataclass
from importlib import resources

from pitchbend_live.clock import now_ts
from pitchbend_live.db.connection import connect, transaction

_FILENAME = re.compile(r"(\d{4})_([a-z0-9_]+)\.sql")

_BOOTSTRAP = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
"""


@dataclass(frozen=True)
class Migration:
    version: str
    name: str
    sql: str


def discover(package: str = "pitchbend_live.db.migrations") -> list[Migration]:
    found: list[Migration] = []
    for entry in resources.files(package).iterdir():
        match = _FILENAME.fullmatch(entry.name)
        if match:
            found.append(Migration(match.group(1), match.group(2), entry.read_text("utf-8")))
    found.sort(key=lambda m: m.version)
    versions = [m.version for m in found]
    if len(versions) != len(set(versions)):
        raise RuntimeError("duplicate migration version")
    return found


def split_statements(sql: str) -> list[str]:
    """Split a script into complete statements (``sqlite3.complete_statement`` aware)."""
    statements: list[str] = []
    buffer = ""
    for line in sql.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statement = buffer.strip()
            if statement.rstrip(";").strip() and not _only_comments(statement):
                statements.append(statement)
            buffer = ""
    if buffer.strip() and not _only_comments(buffer):
        raise ValueError("migration ends with an incomplete statement")
    return statements


def _only_comments(text: str) -> bool:
    return all(
        not line.strip() or line.strip().startswith("--") or line.strip() == ";"
        for line in text.splitlines()
    )


def apply_migrations(db_path: str, migrations: list[Migration] | None = None) -> list[str]:
    """Apply pending migrations; return the versions applied by this call."""
    pending_source = discover() if migrations is None else migrations
    conn = connect(db_path)
    try:
        with transaction(conn):
            conn.execute(_BOOTSTRAP)
            applied = {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}
            done: list[str] = []
            for migration in pending_source:
                if migration.version in applied:
                    continue
                for statement in split_statements(migration.sql):
                    conn.execute(statement)
                conn.execute(
                    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                    (migration.version, migration.name, now_ts()),
                )
                done.append(migration.version)
        return done
    finally:
        conn.close()
