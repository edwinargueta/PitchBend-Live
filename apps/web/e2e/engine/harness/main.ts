// Test harness page for the audio engine's browser tests (e2e/engine/*.spec.ts).
// Exposes the real engine and some DSP helpers on `window.harness`; the Play
// and Pause buttons let Playwright call play() from a genuine user gesture.
import { createAudioEngine, encodeWav } from "../../../src/audio";
import {
  bursts,
  dominantFrequency,
  makeSignal,
  toAudioBuffer,
  type SignalSpec,
} from "./dsp";

// Test-only tap: anything the page connects to a realtime destination also
// feeds an AnalyserNode, so tests can check what is actually being played.
const taps: AnalyserNode[] = [];
type Connect = (this: AudioNode, ...args: unknown[]) => unknown;
const originalConnect = Reflect.get(AudioNode.prototype, "connect") as Connect;
Reflect.set(
  AudioNode.prototype,
  "connect",
  function (this: AudioNode, ...args: unknown[]) {
    const [destination] = args;
    if (
      destination instanceof AudioDestinationNode &&
      this.context instanceof AudioContext
    ) {
      const tap = this.context.createAnalyser();
      tap.fftSize = 4096;
      tap.smoothingTimeConstant = 0;
      taps.push(tap);
      originalConnect.call(this, tap);
    }
    return originalConnect.apply(this, args);
  },
);

/** Peak frequency currently playing (Hz), or null when silent. */
function liveFrequency(): number | null {
  const tap = taps.at(-1);
  if (!tap) return null;
  const bins = new Float32Array(tap.frequencyBinCount);
  tap.getFloatFrequencyData(bins);
  let peak = 1;
  for (let k = 2; k < bins.length - 1; k++) {
    if ((bins[k] ?? -Infinity) > (bins[peak] ?? -Infinity)) peak = k;
  }
  const b = bins[peak] ?? -Infinity;
  if (b < -90) return null;
  const a = bins[peak - 1] ?? b;
  const c = bins[peak + 1] ?? b;
  const denom = a - 2 * b + c;
  const offset = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
  return ((peak + offset) * tap.context.sampleRate) / tap.fftSize;
}

export interface LogEntry {
  event: "timeupdate" | "ended" | "error";
  t: number;
  message?: string;
}

const engine = createAudioEngine();
const log: LogEntry[] = [];
engine.on("timeupdate", (t) => {
  log.push({ event: "timeupdate", t: t as number });
});
engine.on("ended", () => {
  log.push({ event: "ended", t: engine.currentTime });
});
engine.on("error", (err) => {
  const cause = err instanceof Error ? err.cause : undefined;
  const message =
    cause instanceof Error
      ? `${String(err)} (cause: ${cause.name}: ${cause.message})`
      : String(err);
  log.push({ event: "error", t: engine.currentTime, message });
});

document.querySelector("#play")?.addEventListener("click", () => {
  engine.play();
});
document.querySelector("#pause")?.addEventListener("click", () => {
  engine.pause();
});

/**
 * Can this browser run a realtime AudioContext here? Some can't without an
 * audio device (Firefox in Docker/CI never leaves "suspended"). Started from
 * the #probe button so resume() runs inside a user gesture.
 */
let probe: Promise<boolean> | null = null;
document.querySelector("#probe")?.addEventListener("click", () => {
  probe ??= (async () => {
    const ctx = new AudioContext();
    try {
      void ctx.resume().catch(() => undefined);
      for (let waited = 0; waited < 1500; waited += 50) {
        if (ctx.state === "running" && ctx.currentTime > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    } finally {
      void ctx.close().catch(() => undefined);
    }
  })();
});

const harness = {
  /** Engine behind the Play/Pause buttons. */
  engine,
  log,
  createAudioEngine,
  encodeWav,
  dominantFrequency,
  bursts,
  liveFrequency,
  /** Result of the #probe button (false until it has been clicked). */
  realtimeAudioWorks(): Promise<boolean> {
    return probe ?? Promise.resolve(false);
  },
  offlineSuspendSupported:
    typeof (OfflineAudioContext.prototype as { suspend?: unknown }).suspend ===
    "function",
  signalBuffer(spec: SignalSpec): AudioBuffer {
    return toAudioBuffer(makeSignal(spec), spec.sampleRate);
  },
  /** A WAV (made with encodeWav) of the signal, as a blob: URL for load(). */
  signalUrl(spec: SignalSpec): string {
    return URL.createObjectURL(encodeWav(harness.signalBuffer(spec)));
  },
};

export type Harness = typeof harness;

declare global {
  interface Window {
    harness: Harness;
  }
}

window.harness = harness;
