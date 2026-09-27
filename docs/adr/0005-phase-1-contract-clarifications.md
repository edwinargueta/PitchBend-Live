# 0005. Phase 1 contract clarifications
Date: 2026-09-26
Status: Accepted

## Context
Phase 1 is built by parallel workstreams against ARCHITECTURE.md §6. Several details that cross the API/worker/browser boundary are missing or ambiguous there:
- the 404 case
- where `retry_after_s` goes
- dedup of in-flight or failed tracks
- SSE replay
- where uploads are staged
- key spelling

They're settled here, once, before any code, so no workstream resolves them differently. §6 is updated to match.

## Decision

### REST and errors (§6.4, §6.6)
1. **New error code `NOT_FOUND` (HTTP 404).** It covers an unknown, malformed, or **expired** `track_id` / `job_id` on `GET /api/tracks/{id}` and `GET /api/jobs/{id}/events`. Expired tracks are treated as gone, even before cleanup deletes them.
2. **Rate limiting:**
   - The `RATE_LIMITED` body is `{"error":{"code":"RATE_LIMITED","message":"…","retry_after_s":<int>}}`, plus a `Retry-After` header with the same value.
   - One token bucket per client IP (`request.client.host`, which uvicorn's `--proxy-headers` sets from the trusted `X-Forwarded-For`). It's stored in Valkey and shared by `POST /api/jobs` and `POST /api/uploads`.
   - Capacity is `RATE_LIMIT_JOBS_PER_HOUR`, refilling continuously over an hour.
   - Jobs are checked after URL validation, so invalid URLs cost nothing, and before dedup, so cache hits count (§10 A2 order). Uploads are checked before the body is read.
3. **A cache hit follows §6.4 exactly:** `200 {"job_id","track_id","status":"done"}`, with no `audio_url`. The client calls `GET /api/tracks/{id}`. `job_id` is the track's most recent ingest job. §10's "returns 200 with audio_url" is corrected to match.
4. **Dedup by `source_key`:**
   - `ready` and not expired: cache hit (200).
   - `queued` / `fetching` (in flight): `202` with the **existing** `job_id` and `track_id`, so the client joins the same SSE stream.
   - `error` or expired: delete the old row and file, then create a fresh track and job (202).
5. **Validation failures use the §6.6 shape, never FastAPI's default 422 body:**
   - a bad or missing `url` → `INVALID_URL` 400
   - a missing, empty, or non-audio `file` → `UNSUPPORTED_FILE` 400
   - anything unexpected → `INTERNAL` 500 (no stack traces in responses)
6. **The track `status` field** only ever takes the values `queued | fetching | ready | error` (§6.4). `fetching` covers both the YouTube download and upload normalization. `jobs.status` is `queued | running | done | error`.

### SSE (§6.5)
7. **Replay on connect:**
   - The server subscribes to `job:<job_id>` **first**, then reads `job_state:<job_id>`, then streams, so nothing is lost in between.
   - `job_state` is JSON: `{"progress":{…}|null,"audio_ready":{…}|null,"key_ready":{…}|null,"error":{…}|null,"done":bool}`, with a TTL of `MEDIA_TTL_HOURS`.
   - Replay order: progress → audio_ready → key_ready or error → done.
   - If `job_state` is missing (e.g. Valkey restarted) but the job exists, the server rebuilds it from SQLite. A ready track gives `audio_ready` (+ `key_ready` if known) + `done`; an error gives `error`; otherwise `progress {stage:"queued"}`.
8. **Stream lifetime:**
   - A `: ping` comment goes out every 15 s.
   - The stream **ends** after `done` or after a fatal `error`.
   - `KEY_DETECTION_FAILED` is non-fatal and is always followed by `done`.
   - Duplicate events are harmless, because clients treat events as idempotent.
9. **Progress stages:**
   - `queued`: waiting for the worker
   - `fetching`: yt-dlp download (with `pct`) or upload intake
   - `processing`: transcode/normalize
   - `analyzing`: key detection, which only starts **after** `audio_ready`

### Configuration (§6.2)
10. **New key `TMP_DIR=/data/tmp`.** It stages uploads and yt-dlp downloads on the shared PVC, so the worker pod can read what the api pod received, and the final rename into `MEDIA_DIR` is atomic (same filesystem). It's never served by nginx, and created mode 0750 like `/data/db`. Cleanup deletes files in it older than 1 hour. Host-native `make dev` uses `.data/tmp`.

### Uploads
11. **Accepting an upload:**
    - `MAX_UPLOAD_MB` is enforced **while streaming**: a request whose `Content-Length` exceeds the limit (plus a small multipart allowance) gets 413 immediately. Otherwise bytes are counted as they're written to `TMP_DIR`, and the upload is aborted at the limit.
    - Oversized, rejected, or failed uploads leave no temp file behind.
    - Acceptance is decided by magic-byte sniffing, then `ffprobe` (≥ 1 audio stream, and a container from mp3, wav, mp4/m4a/aac, flac, ogg/opus). The extension and the client's Content-Type don't count.
    - Duration > `MAX_DURATION_S` → `VIDEO_TOO_LONG` (422), the same code as for videos.
    - `source_key` is `up:` + the first 16 hex characters of the SHA-256 of the file bytes, computed while streaming.
12. **Titles** come from the upload filename stem or the yt-dlp title. Both are sanitized by one shared function: strip path components and control characters, collapse whitespace, cap at 120 characters, fall back to "Untitled". Titles are display-only (CLAUDE.md "Untrusted input").

### Key detection
13. **Result format:**
    - `tonic` uses the **sharps-only canonical names** `C C# D D# E F F# G G# A A# B`, and `mode` is `major | minor`. The browser's `src/lib/music.ts` owns enharmonic spelling for display (§6.8 rule: flats for F, B♭, E♭, A♭, D♭, G♭ majors and their relative minors). Spelling logic lives in one place.
    - `confidence` is 0–1, rounded to 2 decimals. `alternates` holds the next 2 candidates. `tuning_cents` is an integer in [−50, 50].

### Browser audio engine (§6.8)
17. **`AudioEngine` gains three additive members,** used by the UI and implemented by the engine:
    - `readonly audioBuffer: AudioBuffer | null`: the decoded source, so the waveform needs no second download (§10 C3).
    - `dispose(): void`: stops playback and releases the AudioContext.
    - An optional `onProgress(pct)` in `renderOffline`'s options, so the export shows progress (§10 C6).

    The interface lives in `apps/web/src/audio/index.ts`, and the wire types in `apps/web/src/lib/types.ts`.

### Backend internals (not contracts, recorded for consistency)
14. **SQLite:**
    - WAL mode, `busy_timeout=5000`, foreign keys on.
    - Migrations are versioned SQL files (`keyshift/db/migrations/NNNN_name.sql`), recorded in `schema_migrations`, and applied at startup by **both** api and worker under `BEGIN IMMEDIATE`, which makes them idempotent and race-safe. Shipped migration files are never edited.
    - The §6.7 schema is exact. The only additions are `schema_migrations` and indexes.
    - Timestamps are UTC ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`). `expires_at = created_at + MEDIA_TTL_HOURS`, and a cache hit doesn't extend it (24 h retention).
15. **Worker:**
    - yt-dlp runs as a Python library, only ever given the rebuilt `https://www.youtube.com/watch?v=<id>` URL, with `noplaylist`. Its JavaScript runtime is Deno from the `yt-dlp[deno]` extra.
    - ffmpeg/ffprobe run as argv lists (`asyncio.create_subprocess_exec`).
    - Blocking or CPU-bound work (yt-dlp, librosa) runs off the event loop (`asyncio.to_thread`), so ARQ's 30 s health check keeps refreshing during long jobs.
    - `WORKER_CONCURRENCY=1` (ADR 0003). The cleanup cron runs hourly and at startup.
16. **Logging:**
    - JSON lines on stdout: `ts`, `level`, `logger`, `msg`, plus `job_id` / `track_id` / `event` / `code` when relevant.
    - **Never** logged: secrets, cookies, client IPs, `source_key`, titles, or raw URLs (CLAUDE.md, §14 ToS posture).

## Alternatives considered
- **404 as `INVALID_URL` or `INTERNAL`:** misleading to the user and to clients.
- **Put `retry_after_s` only in the header:** §6.6 says the error "includes" it, so it goes in the body, and the header is added for HTTP clients.
- **Reject re-submissions while a job is in flight (409):** worse UX than joining the existing job, and it needs a new error code.
- **Stage uploads in the api pod's `/tmp`:** the worker pod can't see it.
- **Stage uploads in `MEDIA_DIR`:** nginx would serve half-written files.
- **Spell keys in the backend:** it would duplicate the display rules the browser needs anyway, for transposed keys.

## Consequences
- §6.2 gains `TMP_DIR`, and §6.6 gains `NOT_FOUND` and the `retry_after_s` placement. §10's cache-hit acceptance wording is fixed.
- The ConfigMap, the api/worker init container, the api image, Compose, and `make dev` all provision `TMP_DIR`.
- The frontend types in `apps/web/src/lib/types.ts` mirror §6.4/§6.5 plus these rules.
