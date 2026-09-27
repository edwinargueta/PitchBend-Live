-- 0001: the ARCHITECTURE.md §6.7 schema, verbatim, plus schema_migrations and indexes
-- (ADR 0005 §14). Shipped migration files are never edited; add a new NNNN_*.sql instead.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE tracks (
  track_id      TEXT PRIMARY KEY,
  source_key    TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL CHECK (source IN ('youtube','upload')),
  title         TEXT,
  duration_s    REAL,
  status        TEXT NOT NULL,
  media_file    TEXT,              -- '<uuid>.m4a'
  key_tonic     TEXT,
  key_mode      TEXT,
  key_confidence REAL,
  key_alternates TEXT,             -- JSON
  tuning_cents  INTEGER,
  error_code    TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE TABLE jobs (
  job_id     TEXT PRIMARY KEY,
  track_id   TEXT NOT NULL REFERENCES tracks(track_id),
  kind       TEXT NOT NULL,        -- 'ingest' (Phase 2 adds 'export')
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The hourly cleanup scans by expiry; dedup and SSE look up a track's jobs.
CREATE INDEX idx_tracks_expires_at ON tracks(expires_at);
CREATE INDEX idx_jobs_track_id ON jobs(track_id);
