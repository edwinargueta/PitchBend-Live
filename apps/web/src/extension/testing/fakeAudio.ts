// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Web Audio fakes for the extension's unit tests (jsdom has no Web Audio).
// Separate from src/audio/testing so workstream B's helpers stay untouched.
import type { StretchNode, StretchSegment } from "signalsmith-stretch";
import { vi } from "vitest";

export class FakeParam {
  value: number;
  readonly ramps: { value: number; time: number }[] = [];
  readonly cancelScheduledValues = vi.fn(() => this);
  readonly setValueAtTime = vi.fn((value: number) => {
    this.value = value;
    return this;
  });
  readonly linearRampToValueAtTime = vi.fn((value: number, time: number) => {
    this.ramps.push({ value, time });
    this.value = value;
    return this;
  });

  constructor(value: number) {
    this.value = value;
  }
}

export class FakeNode {
  readonly connections: unknown[] = [];
  readonly connect = vi.fn((target: unknown) => {
    this.connections.push(target);
    return target;
  });
  readonly disconnect = vi.fn();
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}

export class FakeSource extends FakeNode {
  readonly element: unknown;

  constructor(element: unknown) {
    super();
    this.element = element;
  }
}

export class FakeStretch extends FakeNode {
  readonly segments: StretchSegment[] = [];
  latencySeconds = 0.06;
  scheduleError: unknown = null;
  readonly configure = vi.fn(() => Promise.resolve());
  readonly latency = vi.fn(() => Promise.resolve(this.latencySeconds));
  readonly schedule = vi.fn((segment: StretchSegment) => {
    this.segments.push({ ...segment });
    return this.scheduleError === null
      ? Promise.resolve(segment)
      : Promise.reject(
          this.scheduleError instanceof Error
            ? this.scheduleError
            : new Error("schedule failed"),
        );
  });

  get lastSemitones(): number | undefined {
    return this.segments.at(-1)?.semitones;
  }

  asNode(): StretchNode {
    return this as unknown as StretchNode;
  }
}

export class FakeContext {
  state: AudioContextState;
  currentTime = 1;
  baseLatency: number | undefined = 0.01;
  readonly sampleRate = 48000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  throwOnSource: unknown = null;
  resumeResult: "run" | "stay" | "reject" = "run";
  private readonly listeners = new Set<() => void>();

  readonly createGain = vi.fn(() => {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  });
  readonly createMediaElementSource = vi.fn((element: unknown) => {
    if (this.throwOnSource !== null) {
      throw this.throwOnSource instanceof Error
        ? this.throwOnSource
        : new Error("source failed");
    }
    const source = new FakeSource(element);
    this.sources.push(source);
    return source;
  });
  readonly resume = vi.fn(() => {
    if (this.resumeResult === "reject") {
      return Promise.reject(new Error("not allowed"));
    }
    if (this.resumeResult === "run") this.setState("running");
    return Promise.resolve();
  });
  readonly close = vi.fn(() => Promise.resolve());
  readonly addEventListener = vi.fn((_type: string, cb: () => void) => {
    this.listeners.add(cb);
  });
  readonly removeEventListener = vi.fn((_type: string, cb: () => void) => {
    this.listeners.delete(cb);
  });

  constructor(state: AudioContextState = "running") {
    this.state = state;
  }

  get dry(): FakeGain {
    const gain = this.gains[0];
    if (!gain) throw new Error("no dry gain");
    return gain;
  }

  get wet(): FakeGain {
    const gain = this.gains[1];
    if (!gain) throw new Error("no wet gain");
    return gain;
  }

  setState(state: AudioContextState): void {
    this.state = state;
    for (const cb of this.listeners) cb();
  }

  asContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}
