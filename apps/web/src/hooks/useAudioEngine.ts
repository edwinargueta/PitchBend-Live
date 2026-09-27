// Owns one AudioEngine per audio URL (§6.8): created lazily once a track is
// chosen, loaded with progress, and disposed when the URL changes or the
// component unmounts. Pitch changes go straight to the engine (no server, D1).
import { useCallback, useEffect, useState } from "react";
import type { AudioEngine } from "../audio";
// Straight from ./errors: tiny, and keeps the engine itself out of this chunk.
import { asEngineError, EngineError } from "../audio/errors";
import { loadAudioModule } from "./audioModule";

/**
 * "error" means the engine can't play this track (every kind except
 * `playback`). A `playback` error leaves the status "ready": the next play()
 * tries to resume the AudioContext again.
 */
export type EngineStatus = "loading" | "ready" | "error";

export interface EngineView {
  engine: AudioEngine | null;
  status: EngineStatus;
  /** Download/decode progress 0..100, null when unknown. */
  loadPct: number | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  audioBuffer: AudioBuffer | null;
  /** The failure to explain, if any (kept, not swallowed); cleared by play and retry. */
  error: EngineError | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  /** Dispose this engine and load the same URL into a new one. */
  retry: () => void;
}

interface EngineState {
  url: string;
  engine: AudioEngine | null;
  status: EngineStatus;
  loadPct: number | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  audioBuffer: AudioBuffer | null;
  error: EngineError | null;
}

const initialState = (url: string, durationHint: number): EngineState => ({
  url,
  engine: null,
  status: "loading",
  loadPct: null,
  currentTime: 0,
  duration: durationHint,
  isPlaying: false,
  audioBuffer: null,
  error: null,
});

/** For developers: once per failure, with the kind and the underlying cause. */
function logEngineError(err: EngineError): void {
  console.error(`[audio] ${err.kind} error: ${err.message}`, {
    kind: err.kind,
    hint: err.hint,
    cause: err.cause,
  });
}

export function useAudioEngine(url: string, durationHint = 0): EngineView {
  const [state, setState] = useState<EngineState>(() =>
    initialState(url, durationHint),
  );
  // Bumped by retry(): a new attempt re-runs the load effect with a new engine.
  const [attempt, setAttempt] = useState(0);

  // A new URL starts from a clean slate (render-time reset, no effect needed).
  if (state.url !== url) {
    setState(initialState(url, durationHint));
  }

  useEffect(() => {
    let cancelled = false;
    // A function, so TypeScript doesn't narrow the flag across awaits.
    const isCancelled = () => cancelled;
    let engine: AudioEngine | null = null;
    const offs: (() => void)[] = [];

    const sync = (patch: Partial<EngineState> = {}) => {
      if (isCancelled() || !engine) return;
      const e = engine;
      setState((s) =>
        s.url === url
          ? {
              ...s,
              currentTime: e.currentTime,
              isPlaying: e.isPlaying,
              ...patch,
            }
          : s,
      );
    };

    const fail = (reason: unknown) => {
      if (isCancelled()) return;
      const err = asEngineError(
        reason,
        "processor",
        "The audio engine failed unexpectedly.",
      );
      logEngineError(err);
      setState((s) => {
        if (s.url !== url) return s;
        // Not a dead end: keep the player usable so Play can try again.
        if (err.kind === "playback" && s.status === "ready") {
          return { ...s, error: err, isPlaying: false };
        }
        // Keep the first fatal error: later ones are usually its fallout.
        if (s.status === "error") return s;
        return { ...s, status: "error", error: err, isPlaying: false };
      });
    };

    void (async () => {
      try {
        let createAudioEngine: () => AudioEngine;
        try {
          ({ createAudioEngine } = await loadAudioModule());
        } catch (err) {
          throw new EngineError(
            "network",
            "Couldn't download the audio engine. Check your connection.",
            { cause: err },
          );
        }
        if (isCancelled()) return;
        engine = createAudioEngine();
        offs.push(
          engine.on("timeupdate", () => {
            sync();
          }),
          engine.on("ended", () => {
            sync();
          }),
          engine.on("error", fail),
        );
        await engine.load(url, (pct) => {
          if (isCancelled()) return;
          setState((s) => (s.url === url ? { ...s, loadPct: pct } : s));
        });
        if (isCancelled()) return;
        const e = engine;
        setState((s) =>
          // An `error` event during the load (e.g. the worklet crashing) wins.
          s.url === url && s.status !== "error"
            ? {
                ...s,
                engine: e,
                status: "ready",
                loadPct: 100,
                duration: e.duration || s.duration,
                currentTime: e.currentTime,
                isPlaying: e.isPlaying,
                audioBuffer: e.audioBuffer,
              }
            : s,
        );
      } catch (err) {
        // Superseded loads (unmount, new URL, retry) are dropped by `fail`
        // via the cancelled flag, so nothing here can be left spinning.
        fail(err);
      }
    })();

    return () => {
      cancelled = true;
      for (const off of offs) off();
      engine?.dispose();
    };
  }, [url, attempt]);

  const ready = state.status === "ready" ? state.engine : null;

  // Starting playback clears a `playback` error; if resume fails again the
  // engine reports it again.
  const refresh = useCallback((e: AudioEngine, starting = false) => {
    setState((s) =>
      s.engine === e
        ? {
            ...s,
            currentTime: e.currentTime,
            isPlaying: e.isPlaying,
            error: starting ? null : s.error,
          }
        : s,
    );
  }, []);

  const play = useCallback(() => {
    if (!ready) return;
    ready.play();
    refresh(ready, true);
  }, [ready, refresh]);

  const pause = useCallback(() => {
    if (!ready) return;
    ready.pause();
    refresh(ready);
  }, [ready, refresh]);

  const toggle = useCallback(() => {
    if (!ready) return;
    const starting = !ready.isPlaying;
    if (starting) ready.play();
    else ready.pause();
    refresh(ready, starting);
  }, [ready, refresh]);

  const seek = useCallback(
    (seconds: number) => {
      // The engine throws a RangeError on non-finite input.
      if (!ready || !Number.isFinite(seconds)) return;
      const t = Math.min(Math.max(0, seconds), ready.duration || seconds);
      ready.seek(t);
      // Show the new position immediately, even before the next timeupdate.
      setState((s) => (s.engine === ready ? { ...s, currentTime: t } : s));
    },
    [ready],
  );

  const retry = useCallback(() => {
    setState((s) => initialState(s.url, s.duration));
    setAttempt((n) => n + 1);
  }, []);

  return {
    engine: ready,
    status: state.status,
    loadPct: state.loadPct,
    currentTime: state.currentTime,
    duration: state.duration,
    isPlaying: state.isPlaying,
    audioBuffer: state.audioBuffer,
    error: state.error,
    play,
    pause,
    toggle,
    seek,
    retry,
  };
}
