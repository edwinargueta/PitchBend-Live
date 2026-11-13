// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabStatus } from "../shared/protocol";
import { DEFAULT_SETTINGS } from "../shared/tabState";
import { FakeContext, FakeStretch } from "../testing/fakeAudio";
import { LiveGraph } from "./liveGraph";
import {
  dominantFrequency,
  PROBE_FFT_SIZE,
  PROBE_INTERVAL_MS,
  startProbe,
  type ProbeSample,
} from "./probe";

const status: TabStatus = {
  state: "active",
  settings: DEFAULT_SETTINGS,
  site: "youtube",
  shifterMs: 60,
  addedMs: 70,
  error: null,
  appliedAt: null,
  sentAt: null,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("dominantFrequency", () => {
  const bins = (peak: number, left: number, right: number) => {
    const b = new Float32Array(512).fill(-120);
    b[peak - 1] = left;
    b[peak] = -10;
    b[peak + 1] = right;
    return b;
  };

  it("should return the bin centre for a symmetric peak", () => {
    expect(dominantFrequency(bins(100, -30, -30), 48000, 1024)).toBeCloseTo(
      (100 * 48000) / 1024,
      6,
    );
  });

  it("should interpolate towards the louder neighbour", () => {
    const f = dominantFrequency(bins(100, -40, -20), 48000, 1024) ?? 0;
    expect(f).toBeGreaterThan((100 * 48000) / 1024);
  });

  it("should treat a flat top as the bin centre", () => {
    const flat = new Float32Array(16).fill(-50);
    expect(dominantFrequency(flat, 16, 32)).toBe(0.5);
  });

  it("should cope with too few bins", () => {
    expect(dominantFrequency(new Float32Array(1), 48000, 2)).toBeNull();
    expect(dominantFrequency(new Float32Array([-50, -10]), 8, 4)).toBe(2);
  });

  it("should return null for silence", () => {
    expect(dominantFrequency(new Float32Array(64).fill(-200), 48000, 128)).toBe(
      null,
    );
  });
});

describe("startProbe", () => {
  it("should publish the status without a frequency before a graph exists", () => {
    vi.useFakeTimers();
    const target = document.createElement("div");
    const stop = startProbe(
      { liveGraph: null, status: () => status },
      target,
      () => 5,
    );
    const sample = JSON.parse(target.dataset.pblProbe ?? "{}") as ProbeSample;
    expect(sample).toMatchObject({ state: "active", freq: null, at: 5 });
    stop();
  });

  it("should tap the graph once and publish its frequency every interval", () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    const graph = new LiveGraph(ctx.asContext(), () =>
      Promise.resolve(new FakeStretch().asNode()),
    );
    const target = document.createElement("div");
    let t = 0;
    const stop = startProbe(
      { liveGraph: graph, status: () => status },
      target,
      () => t++,
    );
    vi.advanceTimersByTime(PROBE_INTERVAL_MS * 2);
    expect(ctx.analysers).toHaveLength(1);
    const analyser = ctx.analysers[0];
    expect(analyser?.fftSize).toBe(PROBE_FFT_SIZE);
    expect(ctx.dry.connections).toContain(analyser);
    const sample = JSON.parse(target.dataset.pblProbe ?? "{}") as ProbeSample;
    expect(sample.freq).toBeCloseTo((100 * 48000) / PROBE_FFT_SIZE, 6);
    expect(sample.at).toBe(2);
    stop();
    vi.advanceTimersByTime(PROBE_INTERVAL_MS * 2);
    expect(JSON.parse(target.dataset.pblProbe ?? "{}")).toMatchObject({
      at: 2,
    });
  });
});
