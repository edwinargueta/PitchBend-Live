// Test double for the §6.8 AudioEngine (the real one needs Web Audio + WASM).
import { vi } from "vitest";
import type { AudioEngine, EngineEvent, RenderOptions } from "../../audio";

type Listener = (...a: unknown[]) => void;

export function fakeBuffer(duration = 180, channels = 2): AudioBuffer {
  const sampleRate = 100;
  const length = Math.round(duration * sampleRate);
  const data = Array.from({ length: channels }, (_, c) =>
    Float32Array.from(
      { length },
      (_, i) => ((i % 10) / 10) * (c === 0 ? 1 : -0.5),
    ),
  );
  return {
    duration,
    length,
    numberOfChannels: channels,
    sampleRate,
    getChannelData: (c: number) => data[c] ?? new Float32Array(length),
  } as unknown as AudioBuffer;
}

export class FakeEngine implements AudioEngine {
  currentTime = 0;
  duration = 180;
  isPlaying = false;
  audioBuffer: AudioBuffer | null = null;
  private readonly listeners = new Map<EngineEvent, Set<Listener>>();

  load = vi.fn((_url: string, onProgress?: (pct: number) => void) => {
    onProgress?.(40);
    this.audioBuffer = fakeBuffer(this.duration);
    return Promise.resolve();
  });
  play = vi.fn(() => {
    this.isPlaying = true;
  });
  pause = vi.fn(() => {
    this.isPlaying = false;
  });
  seek = vi.fn((seconds: number) => {
    this.currentTime = seconds;
  });
  setSemitones = vi.fn<(n: number) => void>();
  setCents = vi.fn<(n: number) => void>();
  renderOffline = vi.fn((opts: RenderOptions) => {
    opts.onProgress?.(50);
    return Promise.resolve(fakeBuffer(1, 2));
  });
  dispose = vi.fn();
  on = vi.fn((event: EngineEvent, cb: Listener) => {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(cb);
    this.listeners.set(event, set);
    return () => {
      set.delete(cb);
    };
  });

  emit(event: EngineEvent, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  listenerCount(event: EngineEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

/** A promise you resolve or reject from the outside. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
