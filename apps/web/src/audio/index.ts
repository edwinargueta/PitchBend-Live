// Browser audio engine (§6.8, ADR 0005 §17). Implemented by the audio-engine workstream.
// Live pitch shifting is client-side only (D1); pitch changes never change tempo.
//
// Behavior notes for consumers:
//  - Failures are EngineErrors (./errors) whose `kind` says what went wrong:
//    `unsupported` (no Web Audio / AudioWorklet / WebAssembly, or the
//    processor didn't start within READY_TIMEOUT_MS), `network` (download),
//    `decode` (decodeAudioData; hint "no-aac" when the browser lacks AAC),
//    `processor` (the worklet failed) or `playback` (resume() refused).
//  - load() rejects with an EngineError on failure; it is not also reported as
//    an `error` event. A load superseded by another load() or by dispose()
//    rejects with a DOMException named "AbortError" instead (not an EngineError).
//    onProgress gets increasing integers: 0..90 download, 95 decoded, 100 ready.
//  - Events: `timeupdate` (currentTime: number) at ~10 Hz while playing and on
//    play/pause/seek; `ended` once playback reaches the end; `error`
//    (EngineError of kind `processor` or `playback`) for failures with no
//    promise to reject, e.g. the worklet crashing.
//  - play() after `ended` restarts from 0. Call it from a user gesture: it
//    resumes the AudioContext (autoplay policy). After a `playback` error the
//    engine is still usable: the next play() tries to resume again.
//  - Non-finite numbers (NaN, ±Infinity) passed to seek / setSemitones /
//    setCents / renderOffline throw a RangeError.
//  - dispose() keeps event subscriptions and the pitch setting; load() works
//    again afterwards (a new AudioContext is created).

import {
  createAudioContext,
  createOfflineContext,
  decodeAudio,
} from "./browser";
import { createEngine } from "./engine";
import { loadStretchFactory } from "./stretch";
import { encodeWavBlob } from "./wav";

export {
  EngineError,
  isEngineError,
  type EngineErrorHint,
  type EngineErrorKind,
} from "./errors";

export interface RenderOptions {
  semitones: number;
  cents: number;
  /** 0..100 while the offline render runs. */
  onProgress?: (pct: number) => void;
}

export type EngineEvent = "timeupdate" | "ended" | "error";

export interface AudioEngine {
  load(url: string, onProgress?: (pct: number) => void): Promise<void>;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  /**
   * Integer -12..+12, applied live and click-free (ramped).
   * Non-integers are rounded and out-of-range values clamped.
   */
  setSemitones(n: number): void;
  /** -50..+50 (Phase 1: tuning correction only). Out-of-range values are clamped. */
  setCents(n: number): void;
  readonly currentTime: number;
  readonly duration: number;
  readonly isPlaying: boolean;
  /** The decoded source audio, for the waveform (§10 C3: no second download). Null until loaded. */
  readonly audioBuffer: AudioBuffer | null;
  renderOffline(opts: RenderOptions): Promise<AudioBuffer>;
  on(event: EngineEvent, cb: (...a: unknown[]) => void): () => void;
  /** Stop playback and release the AudioContext. */
  dispose(): void;
}

export function createAudioEngine(): AudioEngine {
  return createEngine({
    createContext: () => createAudioContext(),
    createOfflineContext: (channels, length, sampleRate) =>
      createOfflineContext(channels, length, sampleRate),
    loadStretch: loadStretchFactory,
    fetch: (url, init) => fetch(url, init),
    decode: decodeAudio,
  });
}

/** 16-bit PCM stereo WAV (§10 B5). */
export function encodeWav(buffer: AudioBuffer): Blob {
  return encodeWavBlob(buffer);
}
