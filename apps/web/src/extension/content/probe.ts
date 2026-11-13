// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Test probe for the e2e suite (AC-1, AC-2, AC-3, AC-7). Compiled in only for
// `vite build --mode probe` (content/main.ts checks import.meta.env.MODE, so
// production builds drop it). It measures the graph's output frequency with
// an AnalyserNode and publishes it, with the status, on a data- attribute the
// test page can read from the main world.
import type { TabStatus } from "../shared/protocol";
import type { LiveGraph } from "./liveGraph";

export const PROBE_ATTRIBUTE = "pblProbe";
export const PROBE_FFT_SIZE = 8192;
export const PROBE_INTERVAL_MS = 50;
/** Bins quieter than this count as silence. */
export const PROBE_FLOOR_DB = -90;

export interface ProbeSample extends TabStatus {
  readonly freq: number | null;
  readonly at: number;
}

/** Peak bin, refined by parabolic interpolation on the dB values; null if silent. */
export function dominantFrequency(
  bins: Float32Array,
  sampleRate: number,
  fftSize: number,
  floorDb = PROBE_FLOOR_DB,
): number | null {
  const level = (k: number): number => bins[k] ?? Number.NEGATIVE_INFINITY;
  let peak = 1;
  for (let k = 2; k < bins.length - 1; k++) {
    if (level(k) > level(peak)) peak = k;
  }
  const b = level(peak);
  if (!(b > floorDb)) return null;
  const a = level(peak - 1);
  const c = level(peak + 1);
  const offset = (0.5 * (a - c)) / (a - 2 * b + c);
  // A flat top (0/0) or a missing neighbour (±∞) means "use the bin centre".
  return (
    ((peak + (Number.isFinite(offset) ? offset : 0)) * sampleRate) / fftSize
  );
}

export interface ProbeSource {
  readonly liveGraph: LiveGraph | null;
  status(): TabStatus;
}

/** Publish a sample every interval; returns a stopper. */
export function startProbe(
  source: ProbeSource,
  target: HTMLElement,
  now: () => number,
  intervalMs = PROBE_INTERVAL_MS,
): () => void {
  let analyser: AnalyserNode | null = null;
  let bins = new Float32Array(0);
  const sample = (): void => {
    const graph = source.liveGraph;
    if (graph && !analyser) {
      const ctx = graph.context;
      analyser = ctx.createAnalyser();
      analyser.fftSize = PROBE_FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      // A muted sink keeps the analyser in the rendered graph.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(ctx.destination);
      graph.tap(analyser);
      bins = new Float32Array(analyser.frequencyBinCount);
    }
    let freq: number | null = null;
    if (analyser && graph) {
      analyser.getFloatFrequencyData(bins);
      freq = dominantFrequency(
        bins,
        graph.context.sampleRate,
        analyser.fftSize,
      );
    }
    const published: ProbeSample = { ...source.status(), freq, at: now() };
    target.dataset[PROBE_ATTRIBUTE] = JSON.stringify(published);
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
