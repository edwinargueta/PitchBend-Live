// Drives the ingest flow (§10 C2) and feeds `sessionReducer`:
//   POST /api/jobs | /api/uploads → 200 "done": GET /api/tracks/{id} (ADR 0005)
//                                  → 202 "queued": SSE /api/jobs/{id}/events
// Starting a new track, resetting, or unmounting cancels the previous run
// (aborts requests and closes the SSE stream); stale callbacks are ignored.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError, createJob, getTrack, uploadFile } from "../lib/api";
import { LIMITS } from "../lib/errors";
import { subscribeToJob } from "../lib/sse";
import type { JobCreated } from "../lib/types";
import {
  initialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionError,
  type SessionSource,
  type SessionState,
} from "./sessionReducer";

type LastInput =
  { source: "url"; url: string } | { source: "upload"; file: File };

interface Run {
  controller: AbortController;
  unsubscribe: (() => void) | null;
}

export interface TrackSession {
  state: SessionState;
  submitUrl: (url: string) => void;
  submitFile: (file: File) => void;
  /** Re-submit the last URL or file (e.g. after RATE_LIMITED or INTERNAL). */
  retry: () => void;
  canRetry: boolean;
  reset: () => void;
}

/** Checks the name, so it works across realms and for DOMException look-alikes. */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    err.name === "AbortError"
  );
}

/** Generous (MiB) so the client never rejects what the server would accept. */
const MAX_UPLOAD_BYTES = LIMITS.maxUploadMb * 1024 * 1024;

export function toSessionError(err: unknown): SessionError {
  if (err instanceof ApiError) {
    return err.retryAfterS === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, retryAfterS: err.retryAfterS };
  }
  return {
    code: "INTERNAL",
    message: err instanceof Error ? err.message : "Unexpected error",
  };
}

export function useTrackSession(): TrackSession {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const runRef = useRef<Run | null>(null);
  const lastInputRef = useRef<LastInput | null>(null);

  const stop = useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    if (!run) return;
    run.controller.abort();
    run.unsubscribe?.();
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(
    (
      source: SessionSource,
      create: (
        run: Run,
        send: (a: SessionAction) => void,
      ) => Promise<JobCreated>,
    ) => {
      stop();
      const run: Run = { controller: new AbortController(), unsubscribe: null };
      runRef.current = run;
      const alive = () => runRef.current === run;
      const send = (action: SessionAction) => {
        if (alive()) dispatch(action);
      };
      const { signal } = run.controller;

      const fail = (err: unknown) => {
        if (!alive() || isAbortError(err)) return;
        send({ type: "failed", error: toSessionError(err) });
      };

      // Read the track once (cache hit, or to recover after a lost stream).
      const loadTrack = async (trackId: string) => {
        const track = await getTrack(trackId, { signal });
        send({ type: "trackLoaded", track });
        return track;
      };

      const subscribe = (jobId: string, trackId: string) => {
        let finished = false;
        try {
          run.unsubscribe = subscribeToJob(jobId, {
            onProgress: (event) => {
              send({ type: "progress", event });
            },
            onAudioReady: (event) => {
              send({ type: "audioReady", event });
            },
            onKeyReady: (key) => {
              send({ type: "keyReady", key });
            },
            onError: (event) => {
              send({
                type: "jobError",
                error: { code: event.code, message: event.message },
              });
            },
            onDone: () => {
              finished = true;
              send({ type: "done" });
            },
            onConnectionError: () => {
              if (!alive() || finished) return;
              // The stream is gone; the track record is the source of truth now.
              loadTrack(trackId).then((track) => {
                if (track.status === "ready") {
                  send({ type: "done" });
                } else {
                  send({
                    type: "failed",
                    error: {
                      code: "INTERNAL",
                      message: "Lost the connection to the server.",
                    },
                  });
                }
              }, fail);
            },
          });
        } catch (err) {
          fail(err);
        }
      };

      dispatch({ type: "submit", source });
      // A synchronous throw from the client becomes a rejection like any other.
      new Promise<JobCreated>((resolve) => {
        resolve(create(run, send));
      })
        .then(async (job) => {
          if (!alive()) return;
          send({ type: "jobCreated", job });
          if (job.status === "done") {
            const track = await loadTrack(job.track_id);
            // Ready but still analyzing (or no audio yet): follow the job to the end.
            if (alive() && (track.key === null || track.audio_url === null)) {
              subscribe(job.job_id, job.track_id);
            }
          } else {
            subscribe(job.job_id, job.track_id);
          }
        })
        .catch(fail);
    },
    [stop],
  );

  const submitUrl = useCallback(
    (url: string) => {
      lastInputRef.current = { source: "url", url };
      start("url", (run) => createJob(url, { signal: run.controller.signal }));
    },
    [start],
  );

  const submitFile = useCallback(
    (file: File) => {
      if (file.size > MAX_UPLOAD_BYTES) {
        // Don't spend minutes uploading what the server will reject (413).
        stop();
        lastInputRef.current = null;
        dispatch({ type: "submit", source: "upload" });
        dispatch({
          type: "failed",
          error: { code: "FILE_TOO_LARGE", message: "File too large" },
        });
        return;
      }
      lastInputRef.current = { source: "upload", file };
      start("upload", (run, send) =>
        uploadFile(file, {
          signal: run.controller.signal,
          onProgress: (pct) => {
            send({ type: "uploadProgress", pct });
          },
        }),
      );
    },
    [start, stop],
  );

  const retry = useCallback(() => {
    const last = lastInputRef.current;
    if (!last) return;
    if (last.source === "url") submitUrl(last.url);
    else submitFile(last.file);
  }, [submitFile, submitUrl]);

  const reset = useCallback(() => {
    stop();
    lastInputRef.current = null;
    dispatch({ type: "reset" });
  }, [stop]);

  return {
    state,
    submitUrl,
    submitFile,
    retry,
    canRetry: state.source !== null,
    reset,
  };
}
