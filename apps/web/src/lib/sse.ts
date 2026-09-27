// EventSource client for GET /api/jobs/{job_id}/events (§6.5, ADR 0005).
// Implemented by the web-lib workstream.
//
// Delivery rules for one subscription:
// - The server replays the job's state on every (re)connect (ADR 0005 §7), so
//   onAudioReady, onKeyReady and onDone fire at most once, and so does onError
//   for the non-fatal KEY_DETECTION_FAILED. onProgress may repeat.
// - The stream is closed *before* onDone or a fatal onError runs. A fatal error
//   (any code except KEY_DETECTION_FAILED) ends the subscription without onDone.
// - Malformed events are dropped, except an `error` event: that is always
//   delivered, as INTERNAL if its code is missing or unknown.
// - After the unsubscribe function runs, no handler fires.
//
// Reconnects: while the browser retries on its own (readyState CONNECTING), we
// let it. When it gives up (readyState CLOSED, e.g. a 502 while the api pod
// restarts, or a 404 for an expired job), we reconnect after 1 s, 2 s, 4 s, 8 s.
// After MAX_CONSECUTIVE_FAILURES transport errors with no successful `open` in
// between, the stream is closed and onConnectionError fires. With the browsers'
// ~3 s default retry that's roughly 10–15 s without the server.
import { isErrorCode } from "./errors";
import { isMode, isPitchClass } from "./music";
import type {
  AudioReadyEvent,
  JobErrorEvent,
  KeyCandidate,
  KeyReadyEvent,
  ProgressEvent,
  ProgressStage,
} from "./types";
import { isRecord, parseJson } from "./wire";

export interface JobEventHandlers {
  onProgress?: (e: ProgressEvent) => void;
  onAudioReady?: (e: AudioReadyEvent) => void;
  onKeyReady?: (e: KeyReadyEvent) => void;
  /** The job finished; the stream is closed. */
  onDone?: () => void;
  /** A server `error` event. KEY_DETECTION_FAILED is non-fatal and is followed by onDone. */
  onError?: (e: JobErrorEvent) => void;
  /** The connection failed and couldn't be re-established. */
  onConnectionError?: () => void;
}

/** Consecutive transport errors (without an `open` in between) before giving up. */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** First manual reconnect delay; doubles per consecutive failure. */
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 8000;

/** Subscribe to a job's events. Returns an unsubscribe function that closes the stream. */
export function subscribeToJob(
  jobId: string,
  handlers: JobEventHandlers,
): () => void {
  const url = `/api/jobs/${encodeURIComponent(jobId)}/events`;
  let source: EventSource | null = null;
  let closed = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let audioDelivered = false;
  let keyDelivered = false;
  let keyErrorDelivered = false;

  const stop = (): void => {
    closed = true;
    clearTimeout(timer);
    source?.close();
    source = null;
  };

  const connect = (): void => {
    const es = new EventSource(url);
    source = es;
    const live = (): boolean => !closed && source === es;

    es.addEventListener("open", () => {
      if (live()) failures = 0;
    });

    es.addEventListener("progress", (e) => {
      if (!live()) return;
      const event = parseProgress(e.data);
      if (event) handlers.onProgress?.(event);
    });

    es.addEventListener("audio_ready", (e) => {
      if (!live() || audioDelivered) return;
      const event = parseAudioReady(e.data);
      if (!event) return;
      audioDelivered = true;
      handlers.onAudioReady?.(event);
    });

    es.addEventListener("key_ready", (e) => {
      if (!live() || keyDelivered) return;
      const event = parseKeyReady(e.data);
      if (!event) return;
      keyDelivered = true;
      handlers.onKeyReady?.(event);
    });

    es.addEventListener("done", () => {
      if (!live()) return;
      stop();
      handlers.onDone?.();
    });

    // The server's `event: error` and EventSource's own transport `error` share
    // one event type. Only the server's carries data.
    es.addEventListener("error", (e) => {
      if (!live()) return;
      if ("data" in e && typeof e.data === "string") {
        const event = parseJobError(e.data);
        if (event.code === "KEY_DETECTION_FAILED") {
          if (keyErrorDelivered) return;
          keyErrorDelivered = true;
          handlers.onError?.(event);
          return;
        }
        stop();
        handlers.onError?.(event);
        return;
      }

      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        stop();
        handlers.onConnectionError?.();
        return;
      }
      if (es.readyState === EventSource.CLOSED) {
        // The browser won't retry this one (non-200 response); we do.
        es.close();
        source = null;
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** (failures - 1),
          RECONNECT_MAX_DELAY_MS,
        );
        // stop() clears this timer, so it never fires after unsubscribing.
        timer = setTimeout(connect, delay);
      }
      // Otherwise readyState is CONNECTING and the browser is already retrying.
    });
  };

  connect();
  return stop;
}

// ---- payload parsing ---------------------------------------------------------

const STAGES: readonly ProgressStage[] = [
  "queued",
  "fetching",
  "processing",
  "analyzing",
];

function parseProgress(data: unknown): ProgressEvent | null {
  const body = parseData(data);
  if (!isRecord(body)) return null;
  const { stage, pct } = body;
  if (typeof stage !== "string" || !STAGES.includes(stage as ProgressStage)) {
    return null;
  }
  return {
    stage: stage as ProgressStage,
    pct:
      typeof pct === "number" && Number.isFinite(pct)
        ? Math.min(100, Math.max(0, pct))
        : null,
  };
}

function parseAudioReady(data: unknown): AudioReadyEvent | null {
  const body = parseData(data);
  // Only what the player can't do without is required; a missing title or
  // duration must not keep the song from playing.
  if (
    !isRecord(body) ||
    typeof body.track_id !== "string" ||
    typeof body.audio_url !== "string"
  ) {
    return null;
  }
  return {
    track_id: body.track_id,
    audio_url: body.audio_url,
    duration_s: typeof body.duration_s === "number" ? body.duration_s : 0,
    title: typeof body.title === "string" ? body.title : "",
  };
}

function parseKeyReady(data: unknown): KeyReadyEvent | null {
  const body = parseData(data);
  const main = parseCandidate(body);
  if (!main || !isRecord(body)) return null;
  const alternates = Array.isArray(body.alternates)
    ? body.alternates
        .map(parseCandidate)
        .filter((c): c is KeyCandidate => c !== null)
    : [];
  return {
    ...main,
    alternates,
    tuning_cents:
      typeof body.tuning_cents === "number" &&
      Number.isFinite(body.tuning_cents)
        ? body.tuning_cents
        : 0,
  };
}

function parseCandidate(value: unknown): KeyCandidate | null {
  if (!isRecord(value) || !isPitchClass(value.tonic) || !isMode(value.mode)) {
    return null;
  }
  return {
    tonic: value.tonic,
    mode: value.mode,
    confidence: typeof value.confidence === "number" ? value.confidence : 0,
  };
}

function parseJobError(data: string): JobErrorEvent {
  const body = parseJson(data);
  if (!isRecord(body)) return { code: "INTERNAL", message: "" };
  return {
    code: isErrorCode(body.code) ? body.code : "INTERNAL",
    message: typeof body.message === "string" ? body.message : "",
  };
}

function parseData(data: unknown): unknown {
  return typeof data === "string" ? parseJson(data) : undefined;
}
