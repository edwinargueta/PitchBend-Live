// Wire types for the KeyShift API: ARCHITECTURE.md §6.4–6.6 and ADR 0005.
// This file is the browser's copy of the contract; change it only with §6.

/** Sharps-only canonical names the API uses; display spelling lives in music.ts. */
export type PitchClass =
  "C" | "C#" | "D" | "D#" | "E" | "F" | "F#" | "G" | "G#" | "A" | "A#" | "B";

export type Mode = "major" | "minor";

export interface KeyCandidate {
  tonic: PitchClass;
  mode: Mode;
  /** 0..1 */
  confidence: number;
}

/** The `key` object of a track and the `key_ready` SSE payload. */
export interface KeyInfo extends KeyCandidate {
  /** The next two candidates, best first. */
  alternates: KeyCandidate[];
  /** Integer, -50..50. */
  tuning_cents: number;
}

export type TrackStatus = "queued" | "fetching" | "ready" | "error";

/** GET /api/tracks/{track_id} */
export interface Track {
  track_id: string;
  source: "youtube" | "upload";
  title: string | null;
  duration_s: number | null;
  status: TrackStatus;
  /** Same-origin path, e.g. "/media/<uuid>.m4a"; null until audio is ready. */
  audio_url: string | null;
  key: KeyInfo | null;
  /** UTC ISO-8601. */
  expires_at: string;
}

/** POST /api/jobs and POST /api/uploads: 200 "done" (cache hit) or 202 "queued". */
export interface JobCreated {
  job_id: string;
  track_id: string;
  status: "done" | "queued";
}

export type ErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_FILE"
  | "FILE_TOO_LARGE"
  | "VIDEO_TOO_LONG"
  | "LIVESTREAM"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_BLOCKED"
  | "RATE_LIMITED"
  | "KEY_DETECTION_FAILED"
  | "NOT_FOUND"
  | "INTERNAL";

/** Every non-2xx JSON body. `retry_after_s` is present for RATE_LIMITED. */
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; retry_after_s?: number };
}

// ---- SSE: GET /api/jobs/{job_id}/events (§6.5) --------------------------------

export type ProgressStage = "queued" | "fetching" | "processing" | "analyzing";

export interface ProgressEvent {
  stage: ProgressStage;
  /** 0..100, or null when unknown. */
  pct: number | null;
}

export interface AudioReadyEvent {
  track_id: string;
  audio_url: string;
  duration_s: number;
  title: string;
}

export type KeyReadyEvent = KeyInfo;

export interface JobErrorEvent {
  code: ErrorCode;
  message: string;
}
