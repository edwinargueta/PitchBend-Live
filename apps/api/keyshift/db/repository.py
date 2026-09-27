"""Track and job persistence (ARCHITECTURE.md §6.7, ADR 0005 §4, §6, §14).

Plain functions over a ``sqlite3.Connection``; ``keyshift.db.Database`` runs them in a
worker thread so the event loop never waits on SQLite's lock.

Status values (ADR 0005 §6): ``tracks.status`` is ``queued | fetching | ready | error``;
``jobs.status`` is ``queued | running | done | error``. A ready track may carry
``error_code = 'KEY_DETECTION_FAILED'``: playable, key unknown.
"""

import json
import sqlite3
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Literal

from keyshift.clock import ts_after
from keyshift.db.connection import transaction

Source = Literal["youtube", "upload"]

TRACK_QUEUED, TRACK_FETCHING, TRACK_READY, TRACK_ERROR = "queued", "fetching", "ready", "error"
JOB_QUEUED, JOB_RUNNING, JOB_DONE, JOB_ERROR = "queued", "running", "done", "error"
INGEST = "ingest"
KEY_DETECTION_FAILED = "KEY_DETECTION_FAILED"

# A queued/running job older than this is presumed dead (worker crash, or Valkey lost the
# queue): dedup recreates it instead of joining, and the cleanup cron fails it. It must
# exceed the worker's job_timeout (15 min) plus a reasonable queue wait.
STALE_JOB_S = 30 * 60


@dataclass(frozen=True)
class Track:
    track_id: str
    source_key: str  # dedup only: never logged, never in a filename or URL (§6.3)
    source: str
    title: str | None
    duration_s: float | None
    status: str
    media_file: str | None
    key_tonic: str | None
    key_mode: str | None
    key_confidence: float | None
    key_alternates: str | None
    tuning_cents: int | None
    error_code: str | None
    created_at: str
    expires_at: str

    def is_expired(self, now: str) -> bool:
        return self.expires_at <= now

    def key(self) -> dict[str, Any] | None:
        """The §6.4 ``key`` object / §6.5 ``key_ready`` payload, if a key is stored."""
        if self.key_tonic is None or self.key_mode is None:
            return None
        return {
            "tonic": self.key_tonic,
            "mode": self.key_mode,
            "confidence": self.key_confidence,
            "alternates": json.loads(self.key_alternates) if self.key_alternates else [],
            "tuning_cents": self.tuning_cents,
        }


@dataclass(frozen=True)
class Job:
    job_id: str
    track_id: str
    kind: str
    status: str
    created_at: str

    def is_inflight(self, stale_before: str) -> bool:
        """Queued or running, and young enough that a worker may still finish it."""
        return self.status in (JOB_QUEUED, JOB_RUNNING) and self.created_at > stale_before


class DedupKind(StrEnum):
    HIT = "hit"  # ready, fully processed: 200 "done"
    JOINED = "joined"  # still in flight: 202 with the existing ids
    CREATED = "created"  # new track + job: 202, enqueue


@dataclass(frozen=True)
class DedupResult:
    kind: DedupKind
    job_id: str
    track_id: str
    replaced_media_file: str | None = None  # the old row's file, for the caller to delete


def _track(row: sqlite3.Row | None) -> Track | None:
    return Track(**dict(row)) if row is not None else None


def _job(row: sqlite3.Row | None) -> Job | None:
    return Job(**dict(row)) if row is not None else None


def get_track(conn: sqlite3.Connection, track_id: str) -> Track | None:
    return _track(conn.execute("SELECT * FROM tracks WHERE track_id = ?", (track_id,)).fetchone())


def get_track_by_source_key(conn: sqlite3.Connection, source_key: str) -> Track | None:
    row = conn.execute("SELECT * FROM tracks WHERE source_key = ?", (source_key,)).fetchone()
    return _track(row)


def get_job(conn: sqlite3.Connection, job_id: str) -> Job | None:
    return _job(conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone())


def get_job_and_track(conn: sqlite3.Connection, job_id: str) -> tuple[Job, Track] | None:
    job = get_job(conn, job_id)
    if job is None:
        return None
    track = get_track(conn, job.track_id)
    return (job, track) if track is not None else None


def latest_job(conn: sqlite3.Connection, track_id: str) -> Job | None:
    row = conn.execute(
        "SELECT * FROM jobs WHERE track_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        (track_id,),
    ).fetchone()
    return _job(row)


def _reuse(
    conn: sqlite3.Connection, track: Track | None, now: str, stale_before: str
) -> DedupResult | None:
    """ADR 0005 §4: a hit or a join for ``track``, or ``None`` to (re)create it."""
    if track is None or track.is_expired(now):
        return None
    job = latest_job(conn, track.track_id)
    if job is None:
        return None
    inflight = job.is_inflight(stale_before)
    if track.status == TRACK_READY:
        # Ready but still analyzing: join, so the client gets key_ready over SSE.
        kind = DedupKind.JOINED if inflight else DedupKind.HIT
        return DedupResult(kind, job.job_id, track.track_id)
    if track.status in (TRACK_QUEUED, TRACK_FETCHING) and inflight:
        return DedupResult(DedupKind.JOINED, job.job_id, track.track_id)
    return None  # error, or a stale in-flight job whose worker is gone


def find_or_create_ingest(
    conn: sqlite3.Connection,
    *,
    source_key: str,
    source: Source,
    title: str | None,
    duration_s: float | None,
    now: str,
    ttl_hours: float,
    stale_before: str,
    new_track_id: str,
    new_job_id: str,
) -> DedupResult:
    """Dedup by ``source_key``: hit, join, or delete-and-recreate (ADR 0005 §4)."""
    # Fast path without the write lock: cache hits must answer in well under 200 ms.
    found = _reuse(conn, get_track_by_source_key(conn, source_key), now, stale_before)
    if found is not None:
        return found

    with transaction(conn):
        existing = get_track_by_source_key(conn, source_key)
        found = _reuse(conn, existing, now, stale_before)
        if found is not None:
            return found
        replaced: str | None = None
        if existing is not None:
            replaced = existing.media_file
            conn.execute("DELETE FROM jobs WHERE track_id = ?", (existing.track_id,))
            conn.execute("DELETE FROM tracks WHERE track_id = ?", (existing.track_id,))
        conn.execute(
            "INSERT INTO tracks (track_id, source_key, source, title, duration_s, status,"
            " created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                new_track_id,
                source_key,
                source,
                title,
                duration_s,
                TRACK_QUEUED,
                now,
                ts_after(now, hours=ttl_hours),
            ),
        )
        conn.execute(
            "INSERT INTO jobs (job_id, track_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?)",
            (new_job_id, new_track_id, INGEST, JOB_QUEUED, now),
        )
    return DedupResult(DedupKind.CREATED, new_job_id, new_track_id, replaced)


def start_job(conn: sqlite3.Connection, job_id: str) -> Track | None:
    """Claim a queued job for the worker: job -> running, track -> fetching.

    Returns the track, or ``None`` if the job is gone or not queued (a duplicate
    delivery, or a job that cleanup already failed as stale).
    """
    with transaction(conn):
        claimed = conn.execute(
            "UPDATE jobs SET status = ? WHERE job_id = ? AND status = ?",
            (JOB_RUNNING, job_id, JOB_QUEUED),
        ).rowcount
        if claimed != 1:
            return None
        job = get_job(conn, job_id)
        assert job is not None
        conn.execute(
            "UPDATE tracks SET status = ? WHERE track_id = ? AND status = ?",
            (TRACK_FETCHING, job.track_id, TRACK_QUEUED),
        )
        return get_track(conn, job.track_id)


def update_track_metadata(
    conn: sqlite3.Connection, track_id: str, title: str, duration_s: float | None
) -> bool:
    cur = conn.execute(
        "UPDATE tracks SET title = ?, duration_s = COALESCE(?, duration_s)"
        " WHERE track_id = ? AND status = ?",
        (title, duration_s, track_id, TRACK_FETCHING),
    )
    return cur.rowcount == 1


def mark_track_ready(
    conn: sqlite3.Connection, track_id: str, media_file: str, duration_s: float, title: str
) -> bool:
    cur = conn.execute(
        "UPDATE tracks SET status = ?, media_file = ?, duration_s = ?, title = ?,"
        " error_code = NULL WHERE track_id = ? AND status = ?",
        (TRACK_READY, media_file, duration_s, title, track_id, TRACK_FETCHING),
    )
    return cur.rowcount == 1


def save_key(conn: sqlite3.Connection, track_id: str, key: dict[str, Any]) -> bool:
    cur = conn.execute(
        "UPDATE tracks SET key_tonic = ?, key_mode = ?, key_confidence = ?,"
        " key_alternates = ?, tuning_cents = ?, error_code = NULL"
        " WHERE track_id = ? AND status = ?",
        (
            key["tonic"],
            key["mode"],
            key["confidence"],
            json.dumps(key.get("alternates", [])),
            key["tuning_cents"],
            track_id,
            TRACK_READY,
        ),
    )
    return cur.rowcount == 1


def mark_key_failed(conn: sqlite3.Connection, track_id: str) -> bool:
    cur = conn.execute(
        "UPDATE tracks SET error_code = ? WHERE track_id = ? AND status = ?",
        (KEY_DETECTION_FAILED, track_id, TRACK_READY),
    )
    return cur.rowcount == 1


def finish_job(conn: sqlite3.Connection, job_id: str) -> bool:
    cur = conn.execute(
        "UPDATE jobs SET status = ? WHERE job_id = ? AND status = ?",
        (JOB_DONE, job_id, JOB_RUNNING),
    )
    return cur.rowcount == 1


def fail_ingest(conn: sqlite3.Connection, job_id: str, track_id: str, code: str) -> str | None:
    """Track and job -> error with ``code``; returns the media file to delete, if any."""
    with transaction(conn):
        row = conn.execute(
            "SELECT media_file FROM tracks WHERE track_id = ?", (track_id,)
        ).fetchone()
        conn.execute(
            "UPDATE tracks SET status = ?, error_code = ?, media_file = NULL WHERE track_id = ?",
            (TRACK_ERROR, code, track_id),
        )
        conn.execute("UPDATE jobs SET status = ? WHERE job_id = ?", (JOB_ERROR, job_id))
    return row["media_file"] if row is not None else None


def delete_expired(conn: sqlite3.Connection, now: str) -> list[str]:
    """Delete expired tracks and their jobs; return their media files for deletion."""
    with transaction(conn):
        rows = conn.execute(
            "SELECT media_file FROM tracks WHERE expires_at <= ?", (now,)
        ).fetchall()
        conn.execute(
            "DELETE FROM jobs WHERE track_id IN"
            " (SELECT track_id FROM tracks WHERE expires_at <= ?)",
            (now,),
        )
        conn.execute("DELETE FROM tracks WHERE expires_at <= ?", (now,))
    return [row["media_file"] for row in rows if row["media_file"]]


def referenced_media(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT media_file FROM tracks WHERE media_file IS NOT NULL").fetchall()
    return {row["media_file"] for row in rows}


@dataclass(frozen=True)
class StaleJob:
    job_id: str
    track_id: str
    playable: bool  # the audio was ready; only key analysis never finished
    media_file: str | None  # to delete when not playable


def resolve_stale_jobs(conn: sqlite3.Connection, stale_before: str) -> list[StaleJob]:
    """Close jobs stuck queued/running since before ``stale_before`` (worker died, or
    Valkey lost the queue). Playable tracks keep their audio with the key marked failed;
    everything else becomes an ``INTERNAL`` error."""
    resolved: list[StaleJob] = []
    with transaction(conn):
        rows = conn.execute(
            "SELECT j.job_id, j.track_id, t.status AS track_status, t.media_file, t.key_tonic"
            " FROM jobs j JOIN tracks t ON t.track_id = j.track_id"
            " WHERE j.status IN (?, ?) AND j.created_at < ?",
            (JOB_QUEUED, JOB_RUNNING, stale_before),
        ).fetchall()
        for row in rows:
            if row["track_status"] == TRACK_READY:
                conn.execute(
                    "UPDATE jobs SET status = ? WHERE job_id = ?", (JOB_DONE, row["job_id"])
                )
                if row["key_tonic"] is None:
                    conn.execute(
                        "UPDATE tracks SET error_code = ? WHERE track_id = ?",
                        (KEY_DETECTION_FAILED, row["track_id"]),
                    )
                resolved.append(StaleJob(row["job_id"], row["track_id"], True, None))
            else:
                conn.execute(
                    "UPDATE tracks SET status = ?, error_code = ?, media_file = NULL"
                    " WHERE track_id = ?",
                    (TRACK_ERROR, "INTERNAL", row["track_id"]),
                )
                conn.execute(
                    "UPDATE jobs SET status = ? WHERE job_id = ?", (JOB_ERROR, row["job_id"])
                )
                resolved.append(StaleJob(row["job_id"], row["track_id"], False, row["media_file"]))
    return resolved
