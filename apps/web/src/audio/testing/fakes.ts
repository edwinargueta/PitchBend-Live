// Web Audio + signalsmith-stretch fakes for unit tests (jsdom has no Web Audio).
import type {
  StretchFactory,
  StretchNode,
  StretchSegment,
} from "signalsmith-stretch";
import { vi, type Mock } from "vitest";
import type { EngineDeps } from "../engine";
import type { FetchLike } from "../fetchProgress";

export class FakeAudioParam {
  value: number;
  readonly cancelScheduledValues = vi.fn<(time: number) => FakeAudioParam>(
    () => this,
  );
  readonly setValueAtTime = vi.fn<
    (value: number, time: number) => FakeAudioParam
  >((value) => {
    this.value = value;
    return this;
  });
  readonly linearRampToValueAtTime = vi.fn<
    (value: number, time: number) => FakeAudioParam
  >((value) => {
    this.value = value; // the fake jumps to the ramp target
    return this;
  });

  constructor(value: number) {
    this.value = value;
  }
}

export class FakeGainNode {
  readonly gain = new FakeAudioParam(1);
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

export class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = "suspended";
  readonly sampleRate = 48000;
  readonly destination = { kind: "destination" };
  readonly gains: FakeGainNode[] = [];
  readonly resume = vi.fn(() => {
    this.state = "running";
    return Promise.resolve();
  });
  readonly close = vi.fn(() => {
    this.state = "closed";
    return Promise.resolve();
  });
  readonly createGain = vi.fn(() => {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  });

  get output(): FakeGainNode {
    const gain = this.gains[0];
    if (!gain) throw new Error("no gain node created");
    return gain;
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
  }
}

type Handler = (event?: Event) => void;

export class FakeStretchNode {
  readonly context: unknown;
  readonly options: AudioWorkletNodeOptions | undefined;
  readonly segments: StretchSegment[] = [];
  /** Order of buffer messages, e.g. ["drop", "add"]. */
  readonly bufferCalls: string[] = [];
  buffers: Float32Array[] = [];
  transfers: Transferable[] | undefined;
  updateCallback: ((inputTime: number) => void) | undefined;
  private readonly handlers = new Map<string, Set<Handler>>();

  readonly schedule = vi.fn((segment: StretchSegment) => {
    this.segments.push({ ...segment });
    return Promise.resolve(segment);
  });
  readonly addBuffers = vi.fn(
    (buffers: Float32Array[], transfer?: Transferable[]) => {
      this.bufferCalls.push("add");
      this.buffers = buffers;
      this.transfers = transfer;
      return Promise.resolve(buffers[0]?.length ?? 0);
    },
  );
  readonly dropBuffers = vi.fn(() => {
    this.bufferCalls.push("drop");
    this.buffers = [];
    return Promise.resolve({ start: 0, end: 0 });
  });
  readonly setUpdateInterval = vi.fn(
    (_seconds: number, callback?: (inputTime: number) => void) => {
      this.updateCallback = callback;
      return Promise.resolve();
    },
  );
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly addEventListener = vi.fn((type: string, handler: Handler) => {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  });
  readonly removeEventListener = vi.fn((type: string, handler: Handler) => {
    this.handlers.get(type)?.delete(handler);
  });

  constructor(context: unknown, options?: AudioWorkletNodeOptions) {
    this.context = context;
    this.options = options;
  }

  dispatch(type: string, event?: Event): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }

  get lastSegment(): StretchSegment {
    const segment = this.segments.at(-1);
    if (!segment) throw new Error("nothing scheduled");
    return segment;
  }
}

export function fakeAudioBuffer(
  numberOfChannels: number,
  length: number,
  sampleRate = 48000,
  sample: (channel: number, index: number) => number = () => 0,
): AudioBuffer {
  const data = Array.from({ length: numberOfChannels }, (_, c) =>
    Float32Array.from({ length }, (_unused, i) => sample(c, i)),
  );
  return {
    numberOfChannels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (c: number) => {
      const channel = data[c];
      if (!channel) throw new RangeError(`no channel ${String(c)}`);
      return channel;
    },
  } as unknown as AudioBuffer;
}

interface Checkpoint {
  time: number;
  resolve: () => void;
}

export class FakeOfflineContext {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly destination = { kind: "offline-destination" };
  readonly checkpoints: Checkpoint[] = [];
  /** Called once rendering starts (e.g. to simulate processor messages). */
  onRender: (() => void) | undefined;
  suspend: ((time: number) => Promise<void>) | undefined = vi.fn(
    (time: number) =>
      new Promise<void>((resolve) => {
        this.checkpoints.push({ time, resolve });
      }),
  );
  private wake: (() => void) | undefined;
  readonly resume = vi.fn(() => {
    this.wake?.();
    return Promise.resolve();
  });
  readonly startRendering = vi.fn(async () => {
    this.onRender?.();
    const ordered = [...this.checkpoints].sort((a, b) => a.time - b.time);
    for (const checkpoint of ordered) {
      const resumed = new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      checkpoint.resolve();
      await resumed;
    }
    return fakeAudioBuffer(this.numberOfChannels, this.length, this.sampleRate);
  });

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
  }
}

export interface FakeDeps {
  deps: EngineDeps;
  contexts: FakeAudioContext[];
  nodes: FakeStretchNode[];
  offline: FakeOfflineContext[];
  factory: Mock<StretchFactory>;
  /** What decode() resolves with. */
  decoded: { buffer: AudioBuffer };
  fetch: Mock<FetchLike>;
  decode: Mock<EngineDeps["decode"]>;
  loadStretch: Mock<EngineDeps["loadStretch"]>;
  createOfflineContext: Mock<EngineDeps["createOfflineContext"]>;
  /** Called with each new offline context, e.g. to set `onRender`. */
  onOffline: ((ctx: FakeOfflineContext) => void) | undefined;
}

/** Deps wired to fakes: a 10 s stereo track at 48 kHz unless changed via `decoded`. */
export function fakeDeps(options: { offlineSuspend?: boolean } = {}): FakeDeps {
  const contexts: FakeAudioContext[] = [];
  const nodes: FakeStretchNode[] = [];
  const offline: FakeOfflineContext[] = [];
  const decoded = { buffer: fakeAudioBuffer(2, 480_000) };

  const factory = vi.fn<StretchFactory>((ctx, opts) => {
    const node = new FakeStretchNode(ctx, opts);
    nodes.push(node);
    return Promise.resolve(node as unknown as StretchNode);
  });
  const fetch = vi.fn<FetchLike>(() =>
    Promise.resolve(
      new Response(new Uint8Array(1000), {
        headers: { "content-length": "1000" },
      }),
    ),
  );
  const decode = vi.fn<EngineDeps["decode"]>(() =>
    Promise.resolve(decoded.buffer),
  );
  const loadStretch = vi.fn<EngineDeps["loadStretch"]>(() =>
    Promise.resolve(factory),
  );
  const createOfflineContext = vi.fn<EngineDeps["createOfflineContext"]>(
    (channels, length, sampleRate) => {
      const ctx = new FakeOfflineContext(channels, length, sampleRate);
      if (options.offlineSuspend === false) ctx.suspend = undefined;
      offline.push(ctx);
      result.onOffline?.(ctx);
      return ctx as unknown as OfflineAudioContext;
    },
  );

  const deps: EngineDeps = {
    createContext: () => {
      const ctx = new FakeAudioContext();
      contexts.push(ctx);
      return ctx as unknown as AudioContext;
    },
    createOfflineContext,
    loadStretch,
    fetch,
    decode,
  };
  const result: FakeDeps = {
    deps,
    contexts,
    nodes,
    offline,
    factory,
    decoded,
    fetch,
    decode,
    loadStretch,
    createOfflineContext,
    onOffline: undefined,
  };
  return result;
}
