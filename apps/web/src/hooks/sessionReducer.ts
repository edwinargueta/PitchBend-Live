// Pure state machine for one "choose a song → hear it → key" session (§10 C2).
// No DOM, no I/O: `useTrackSession` performs the requests and feeds events in.
//
//   idle ─submit─▶ submitting ─202─▶ waiting (queued → fetching → processing)
//                     │                 │
//                     │200 + getTrack   │audio_ready
//                     ▼                 ▼
//                   ready ◀─────────────┘   player usable; key: pending
//                     │ key_ready → key: ready
//                     │ KEY_DETECTION_FAILED / done-without-key → key: failed
//                     ▼ done
//   any fatal error before audio ─▶ error        reset ─▶ idle
import type {
  AudioReadyEvent,
  ErrorCode,
  JobCreated,
  KeyInfo,
  ProgressEvent,
  ProgressStage,
  Track,
} from "../lib/types";

export type SessionPhase =
  "idle" | "submitting" | "waiting" | "ready" | "error";

export type SessionSource = "url" | "upload";

/** A track whose audio can be loaded into the engine. */
export interface SessionTrack {
  trackId: string;
  audioUrl: string;
  /** Untrusted display text: render as text only. */
  title: string | null;
  durationS: number | null;
}

export type KeyStatus = "pending" | "ready" | "failed";

export interface KeyState {
  status: KeyStatus;
  info: KeyInfo | null;
}

export interface SessionError {
  code: ErrorCode;
  message: string;
  retryAfterS?: number;
}

export interface SessionState {
  phase: SessionPhase;
  source: SessionSource | null;
  /** Upload progress 0..100 while an upload is in flight. */
  uploadPct: number | null;
  /** Latest server stage; null before the first progress event (or on a cache hit). */
  stage: ProgressStage | null;
  pct: number | null;
  jobId: string | null;
  trackId: string | null;
  track: SessionTrack | null;
  key: KeyState;
  done: boolean;
  error: SessionError | null;
}

export type SessionAction =
  | { type: "submit"; source: SessionSource }
  | { type: "uploadProgress"; pct: number }
  | { type: "jobCreated"; job: JobCreated }
  | { type: "progress"; event: ProgressEvent }
  | { type: "audioReady"; event: AudioReadyEvent }
  | { type: "trackLoaded"; track: Track }
  | { type: "keyReady"; key: KeyInfo }
  | { type: "jobError"; error: SessionError }
  | { type: "done" }
  | { type: "failed"; error: SessionError }
  | { type: "reset" };

export const initialSessionState: SessionState = {
  phase: "idle",
  source: null,
  uploadPct: null,
  stage: null,
  pct: null,
  jobId: null,
  trackId: null,
  track: null,
  key: { status: "pending", info: null },
  done: false,
  error: null,
};

const clampPct = (pct: number): number => Math.min(100, Math.max(0, pct));

/** True while a request or job is in flight and no audio is playable yet. */
export function isBusy(state: SessionState): boolean {
  return state.phase === "submitting" || state.phase === "waiting";
}

export function sessionReducer(
  state: SessionState,
  action: SessionAction,
): SessionState {
  switch (action.type) {
    case "submit":
      return {
        ...initialSessionState,
        phase: "submitting",
        source: action.source,
        uploadPct: action.source === "upload" ? 0 : null,
      };

    case "uploadProgress":
      if (state.phase !== "submitting") return state;
      return { ...state, uploadPct: clampPct(action.pct) };

    case "jobCreated":
      if (state.phase !== "submitting") return state;
      return {
        ...state,
        phase: "waiting",
        uploadPct: null,
        jobId: action.job.job_id,
        trackId: action.job.track_id,
        stage: action.job.status === "queued" ? "queued" : null,
        pct: null,
      };

    case "progress":
      // Late or replayed events after the track is ready only matter for "analyzing".
      if (state.phase !== "waiting" && state.phase !== "ready") return state;
      return {
        ...state,
        stage: action.event.stage,
        pct: action.event.pct === null ? null : clampPct(action.event.pct),
      };

    case "audioReady": {
      if (state.phase !== "waiting" && state.phase !== "ready") return state;
      const { event } = action;
      return {
        ...state,
        phase: "ready",
        trackId: event.track_id,
        track: {
          trackId: event.track_id,
          audioUrl: event.audio_url,
          title: event.title,
          durationS: event.duration_s,
        },
        // Replays are idempotent: a key we already have is kept.
      };
    }

    case "trackLoaded": {
      if (state.phase !== "waiting" && state.phase !== "ready") return state;
      const { track } = action;
      if (track.audio_url === null) return state;
      return {
        ...state,
        phase: "ready",
        trackId: track.track_id,
        track: {
          trackId: track.track_id,
          audioUrl: track.audio_url,
          title: track.title,
          durationS: track.duration_s,
        },
        key: track.key ? { status: "ready", info: track.key } : state.key,
      };
    }

    case "keyReady":
      if (state.phase === "idle" || state.phase === "error") return state;
      return { ...state, key: { status: "ready", info: action.key } };

    case "jobError": {
      if (state.phase === "idle" || state.phase === "error") return state;
      const keyFailed: KeyState =
        state.key.status === "ready"
          ? state.key
          : { status: "failed", info: null };
      if (action.error.code === "KEY_DETECTION_FAILED") {
        // Non-fatal (§6.5): the track stays playable.
        return { ...state, key: keyFailed };
      }
      if (state.phase === "ready") {
        // Audio is already playable; a late fatal error only costs us the key.
        return { ...state, key: keyFailed, done: true };
      }
      return { ...state, phase: "error", error: action.error, uploadPct: null };
    }

    case "done":
      if (state.phase === "idle" || state.phase === "error") return state;
      return {
        ...state,
        done: true,
        // The job finished without a key (e.g. a rebuilt replay): the key is unknown.
        key:
          state.phase === "ready" && state.key.status === "pending"
            ? { status: "failed", info: null }
            : state.key,
      };

    case "failed":
      if (state.phase === "idle") return state;
      if (state.phase === "ready") {
        // Audio is already playable; never tear the player down.
        return state.key.status === "pending"
          ? { ...state, key: { status: "failed", info: null } }
          : state;
      }
      return {
        ...state,
        phase: "error",
        error: action.error,
        uploadPct: null,
        stage: null,
        pct: null,
      };

    case "reset":
      return initialSessionState;
  }
}
