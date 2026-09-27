import type { StretchFactory, StretchNode } from "signalsmith-stretch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioUnsupportedError } from "./browser";
import {
  DECODED_PCT,
  DOWNLOAD_PCT,
  Engine,
  FADE_S,
  READY_TIMEOUT_MS,
  TICK_MS,
} from "./engine";
import { EngineError } from "./errors";
import { RAMP_MS } from "./pitch";
import {
  fakeAudioBuffer,
  fakeDeps,
  type FakeAudioContext,
  type FakeDeps,
  FakeStretchNode,
} from "./testing/fakes";

let f: FakeDeps;
let engine: Engine;

function first<T>(items: readonly T[], what: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`no ${what}`);
  return item;
}

async function loaded(
  url = "/media/a.m4a",
): Promise<{ ctx: FakeAudioContext; node: FakeStretchNode }> {
  await engine.load(url);
  return { ctx: first(f.contexts, "context"), node: first(f.nodes, "node") };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Exact sample equality, fast enough for full-length buffers. */
function sameSamples(a: Float32Array | undefined, b: Float32Array): boolean {
  return (
    a !== undefined && a.length === b.length && a.every((v, i) => v === b[i])
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  // Only the engine's timers: Response bodies need the real microtask machinery.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  f = fakeDeps();
  engine = new Engine(f.deps);
});

afterEach(() => {
  engine.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("initial state", () => {
  it("starts empty and ignores transport calls until loaded", () => {
    expect(engine.currentTime).toBe(0);
    expect(engine.duration).toBe(0);
    expect(engine.isPlaying).toBe(false);
    expect(engine.audioBuffer).toBeNull();
    engine.play();
    engine.pause();
    engine.seek(3);
    expect(engine.isPlaying).toBe(false);
    expect(engine.currentTime).toBe(0);
    expect(f.contexts).toHaveLength(0);
  });
});

describe("load", () => {
  it("downloads, decodes and hands the buffer to a stereo stretch node", async () => {
    const pct: number[] = [];
    await engine.load("/media/x.m4a", (p) => pct.push(p));

    expect(f.fetch).toHaveBeenCalledWith(
      "/media/x.m4a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const ctx = first(f.contexts, "context");
    const node = first(f.nodes, "node");
    expect(f.decode).toHaveBeenCalledWith(ctx, expect.any(ArrayBuffer));
    expect(engine.audioBuffer).toBe(f.decoded.buffer);
    expect(engine.duration).toBe(10);
    expect(engine.currentTime).toBe(0);
    expect(engine.isPlaying).toBe(false);

    expect(node.options).toEqual({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    expect(node.connect).toHaveBeenCalledWith(ctx.output);
    expect(ctx.output.connect).toHaveBeenCalledWith(ctx.destination);
    expect(ctx.output.gain.value).toBe(0);
    expect(node.bufferCalls).toEqual(["drop", "add"]);

    // The node gets transferable copies; the exposed AudioBuffer stays intact.
    expect(node.buffers).toHaveLength(2);
    const source = f.decoded.buffer.getChannelData(0);
    // Object.is, not `.not.toBe`: toBe deep-compares non-identical values (twice)
    // to suggest toEqual, which is ~1 s for 480k samples.
    expect(Object.is(node.buffers[0], source)).toBe(false);
    // Compare samples directly: toEqual walks all 480k elements through its
    // generic deep-equality path, which took ~3 s under coverage and once
    // exceeded the 5 s test timeout on the CI runner.
    expect(node.buffers[0]).toHaveLength(source.length);
    expect(sameSamples(node.buffers[0], source)).toBe(true);
    // Identity, not deep equality: the transfer list must be the copies' own
    // ArrayBuffers (and comparing megabytes byte by byte is slow).
    expect(node.transfers).toHaveLength(node.buffers.length);
    (node.transfers ?? []).forEach((transferred, i) => {
      expect(transferred).toBe(node.buffers[i]?.buffer);
    });

    expect(pct[0]).toBe(0);
    expect(pct).toContain(DOWNLOAD_PCT);
    expect(pct).toContain(DECODED_PCT);
    expect(pct.at(-1)).toBe(100);
    for (let i = 1; i < pct.length; i++) {
      expect(pct[i]).toBeGreaterThan(pct[i - 1] ?? -1);
    }
  });

  it("reports download progress as bytes arrive", async () => {
    const chunks = [
      new Uint8Array(250),
      new Uint8Array(250),
      new Uint8Array(500),
    ];
    f.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { headers: { "content-length": "1000" } },
      ),
    );
    const pct: number[] = [];
    await engine.load("/media/x.m4a", (p) => pct.push(p));
    expect(pct).toEqual([0, 22, 45, 90, 95, 100]);
  });

  it("feeds a mono source as one channel (the processor duplicates it)", async () => {
    f.decoded.buffer = fakeAudioBuffer(1, 48_000);
    const { node } = await loaded();
    expect(node.buffers).toHaveLength(1);
  });

  it("keeps only the first two channels of wider sources", async () => {
    f.decoded.buffer = fakeAudioBuffer(6, 48_000, 48000, (c) => c);
    const { node } = await loaded();
    expect(node.buffers.map((b) => b[0])).toEqual([0, 1]);
  });

  it("rejects on an HTTP error and stays empty, then loads again", async () => {
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const failure = engine.load("/media/gone.m4a");
    await expect(failure).rejects.toThrow("HTTP 404");
    await expect(failure).rejects.toMatchObject({ kind: "network" });
    expect(engine.audioBuffer).toBeNull();
    expect(engine.duration).toBe(0);

    await engine.load("/media/a.m4a");
    expect(engine.audioBuffer).toBe(f.decoded.buffer);
  });

  it("rejects with a decode EngineError when decoding fails", async () => {
    const cause = new Error("undecodable");
    f.decode.mockRejectedValueOnce(cause);
    await expect(engine.load("/media/a.m4a")).rejects.toMatchObject({
      name: "EngineError",
      kind: "decode",
      message: "This audio file couldn't be decoded.",
      cause,
    });
    expect(engine.audioBuffer).toBeNull();
  });

  it("keeps a decode EngineError from the browser glue (e.g. the AAC hint)", async () => {
    const err = new EngineError("decode", "No AAC here.", { hint: "no-aac" });
    f.decode.mockRejectedValueOnce(err);
    await expect(engine.load("/media/a.m4a")).rejects.toBe(err);
  });

  it("rejects when the AudioContext can't be created", async () => {
    f.deps.createContext = () => {
      throw new AudioUnsupportedError("no Web Audio");
    };
    await expect(engine.load("/media/a.m4a")).rejects.toMatchObject({
      message: "no Web Audio",
      kind: "unsupported",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("classifies any other AudioContext failure as unsupported", async () => {
    const cause = new DOMException("no audio device", "NotSupportedError");
    f.deps.createContext = () => {
      throw cause;
    };
    await expect(engine.load("/media/a.m4a")).rejects.toMatchObject({
      kind: "unsupported",
      message: "This browser couldn't start Web Audio.",
      cause,
    });
  });

  it("classifies an unexpected failure as processor", async () => {
    const cause = new Error("createGain broke");
    f.deps.createContext = () =>
      ({
        createGain: () => {
          throw cause;
        },
      }) as unknown as AudioContext;
    await expect(engine.load("/media/a.m4a")).rejects.toMatchObject({
      kind: "processor",
      cause,
    });
  });

  it("a failed processor download is a network error, and the next load retries it", async () => {
    const cause = new TypeError("Failed to fetch dynamically imported module");
    f.loadStretch.mockRejectedValueOnce(cause);
    await expect(engine.load("/media/a.m4a")).rejects.toMatchObject({
      kind: "network",
      message: expect.stringContaining("audio processor") as string,
      cause,
    });
    await engine.load("/media/a.m4a");
    expect(f.loadStretch).toHaveBeenCalledTimes(2);
    expect(f.nodes).toHaveLength(1);
    expect(f.contexts).toHaveLength(1);
  });

  it("a processor that can't be created is unsupported, never an abort", async () => {
    // addModule rejects with an AbortError DOMException when, e.g., a CSP blocks blob:.
    const cause = new DOMException(
      "Unable to load a worklet's module.",
      "AbortError",
    );
    f.factory.mockRejectedValueOnce(cause);
    await expect(engine.load("/media/a.m4a")).rejects.toMatchObject({
      name: "EngineError",
      kind: "unsupported",
      cause,
    });
  });

  it("times out a processor that never reports ready (WebAssembly blocked in the worklet)", async () => {
    f.factory.mockReturnValueOnce(new Promise(() => undefined));
    const failure = engine.load("/media/a.m4a");
    const settled = expect(failure).rejects.toMatchObject({
      name: "EngineError",
      kind: "unsupported",
      hint: "no-wasm",
      message: expect.stringMatching(
        /didn't start within 15 s\. WebAssembly may be blocked/,
      ) as string,
    });
    await flush();
    vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
    await flush();
    expect(engine.audioBuffer).toBeNull();
    vi.advanceTimersByTime(1);
    await settled;
  });

  it("fails fast on a processor timeout without waiting for the download, and stops it", async () => {
    f.deps.readyTimeoutMs = 50;
    f.factory.mockReturnValueOnce(new Promise(() => undefined));
    const response = deferred<Response>();
    f.fetch.mockReturnValueOnce(response.promise);
    const failure = engine.load("/media/a.m4a");
    const settled = expect(failure).rejects.toMatchObject({
      kind: "unsupported",
      message: expect.stringContaining("within 0.05 s") as string,
    });
    await flush();
    vi.advanceTimersByTime(50);
    await settled;
    const init = f.fetch.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(true);
    expect(f.decode).not.toHaveBeenCalled();
  });

  it("disconnects a processor that reports ready after the timeout, and retries on the next load", async () => {
    f.deps.readyTimeoutMs = 1000;
    const late = deferred<StretchNode>();
    f.factory.mockReturnValueOnce(late.promise);
    const failure = engine.load("/media/a.m4a");
    const settled = expect(failure).rejects.toMatchObject({ hint: "no-wasm" });
    await flush();
    vi.advanceTimersByTime(1000);
    await settled;
    const lateNode = { disconnect: vi.fn() };
    late.resolve(lateNode as unknown as StretchNode);
    await flush();
    expect(lateNode.disconnect).toHaveBeenCalled();

    await engine.load("/media/a.m4a");
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(engine.audioBuffer).toBe(f.decoded.buffer);
  });

  it("classifies a failed hand-off to the processor as processor", async () => {
    f.factory.mockImplementationOnce((ctx, opts) => {
      const node = new FakeStretchNode(ctx, opts);
      node.addBuffers.mockRejectedValueOnce(new Error("DataCloneError"));
      f.nodes.push(node);
      return Promise.resolve(node as unknown as StretchNode);
    });
    await expect(engine.load("/media/a.m4a")).rejects.toMatchObject({
      kind: "processor",
      message: "Couldn't pass the audio to the audio processor.",
    });
  });

  it("lets a newer load supersede one in flight", async () => {
    const slow = deferred<AudioBuffer>();
    const second = fakeAudioBuffer(2, 96_000);
    f.decode.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(second);
    const firstLoad = engine.load("/media/one.m4a");
    // Let the first load reach decoding before the second one starts.
    await vi.waitFor(() => {
      expect(f.decode).toHaveBeenCalledTimes(1);
    });
    const secondLoad = engine.load("/media/two.m4a");
    await secondLoad;
    await expect(firstLoad).rejects.toMatchObject({ name: "AbortError" });
    slow.resolve(fakeAudioBuffer(2, 10));
    await flush();

    expect(engine.audioBuffer).toBe(second);
    expect(engine.duration).toBe(2);
    const node = first(f.nodes, "node");
    expect(f.nodes).toHaveLength(1);
    expect(node.bufferCalls).toEqual(["drop", "add"]);
  });

  it("a superseded load that then fails still rejects as an abort, not a failure", async () => {
    const slow = deferred<AudioBuffer>();
    f.decode.mockReturnValueOnce(slow.promise);
    const firstLoad = engine.load("/media/one.m4a");
    await vi.waitFor(() => {
      expect(f.decode).toHaveBeenCalledTimes(1);
    });
    const secondLoad = engine.load("/media/two.m4a");
    slow.reject(new Error("undecodable"));
    await expect(firstLoad).rejects.toMatchObject({ name: "AbortError" });
    await expect(firstLoad).rejects.not.toBeInstanceOf(EngineError);
    await secondLoad;
  });

  it("a superseded download rejects as an abort", async () => {
    const response = deferred<Response>();
    f.fetch.mockReturnValueOnce(response.promise);
    const firstLoad = engine.load("/media/one.m4a");
    await flush();
    const secondLoad = engine.load("/media/two.m4a");
    response.reject(new TypeError("Failed to fetch"));
    await expect(firstLoad).rejects.toMatchObject({ name: "AbortError" });
    await secondLoad;
  });

  it("stops playback and swaps buffers when loading over a playing track", async () => {
    const { ctx, node } = await loaded();
    engine.play();
    ctx.advance(2);
    const next = fakeAudioBuffer(2, 144_000);
    f.decoded.buffer = next;
    const pending = engine.load("/media/b.m4a");
    expect(engine.isPlaying).toBe(false);
    expect(node.lastSegment).toMatchObject({ active: false });
    await pending;
    expect(engine.audioBuffer).toBe(next);
    expect(engine.currentTime).toBe(0);
    expect(node.bufferCalls).toEqual(["drop", "add", "drop", "add"]);
    expect(f.contexts).toHaveLength(1);
  });
});

describe("transport", () => {
  it("play resumes a suspended context synchronously and starts at the current position", async () => {
    const { ctx, node } = await loaded();
    ctx.currentTime = 5;
    engine.play();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(engine.isPlaying).toBe(true);
    expect(node.lastSegment).toEqual({
      output: 5,
      active: true,
      input: 0,
      rate: 1,
      semitones: 0,
    });
    expect(ctx.output.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(
      1,
      5 + FADE_S,
    );
    ctx.advance(1.5);
    expect(engine.currentTime).toBeCloseTo(1.5, 9);
  });

  it("doesn't resume a running context, and play while playing is a no-op", async () => {
    const { ctx, node } = await loaded();
    ctx.state = "running";
    engine.play();
    const count = node.segments.length;
    engine.play();
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(node.segments).toHaveLength(count);
  });

  it("pause freezes the position and stops the processor after the fade", async () => {
    const { ctx, node } = await loaded();
    engine.play();
    ctx.advance(2);
    engine.pause();
    expect(engine.isPlaying).toBe(false);
    expect(engine.currentTime).toBeCloseTo(2, 9);
    expect(node.lastSegment).toEqual({
      output: 2 + FADE_S,
      active: false,
      input: 2,
      rate: 1,
      semitones: 0,
    });
    expect(ctx.output.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(
      0,
      2 + FADE_S,
    );
    ctx.advance(3);
    expect(engine.currentTime).toBeCloseTo(2, 9);
    engine.pause(); // no-op
    expect(node.segments.filter((s) => s.active === false)).toHaveLength(1);

    engine.play();
    expect(node.lastSegment).toMatchObject({
      output: 5,
      active: true,
      input: 2,
    });
    ctx.advance(1);
    expect(engine.currentTime).toBeCloseTo(3, 9);
  });

  it("seek while paused moves the position without touching the processor", async () => {
    const { node } = await loaded();
    const times: unknown[] = [];
    engine.on("timeupdate", (t) => times.push(t));
    const count = node.segments.length;
    engine.seek(4);
    expect(engine.currentTime).toBe(4);
    expect(times).toEqual([4]);
    expect(node.segments).toHaveLength(count);
    engine.seek(-3);
    expect(engine.currentTime).toBe(0);
    engine.seek(99);
    expect(engine.currentTime).toBe(10);
  });

  it("seek while playing re-anchors the processor", async () => {
    const { ctx, node } = await loaded();
    engine.play();
    ctx.advance(1);
    engine.seek(7);
    expect(node.lastSegment).toEqual({
      output: 1,
      active: true,
      input: 7,
      rate: 1,
      semitones: 0,
    });
    ctx.advance(0.5);
    expect(engine.currentTime).toBeCloseTo(7.5, 9);
    expect(engine.isPlaying).toBe(true);
  });

  it("seek rejects non-finite positions", async () => {
    await loaded();
    expect(() => {
      engine.seek(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      engine.seek(Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
  });

  it("emits timeupdate at ~10 Hz while playing, and stops on pause", async () => {
    const { ctx } = await loaded();
    const times: number[] = [];
    engine.on("timeupdate", (t) => times.push(t as number));
    engine.play();
    expect(times).toEqual([0]);
    for (let i = 0; i < 10; i++) {
      ctx.advance(TICK_MS / 1000);
      vi.advanceTimersByTime(TICK_MS);
    }
    expect(times).toHaveLength(11);
    expect(times.at(-1)).toBeCloseTo(1, 6);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1] ?? -1);
    }
    engine.pause();
    expect(times).toHaveLength(12);
    vi.advanceTimersByTime(1000);
    expect(times).toHaveLength(12);
  });

  it("fires ended once at the end, then play restarts from 0", async () => {
    f.decoded.buffer = fakeAudioBuffer(2, 48_000); // 1 s
    const { ctx, node } = await loaded();
    const ended = vi.fn();
    const times: number[] = [];
    engine.on("ended", ended);
    engine.on("timeupdate", (t) => times.push(t as number));
    engine.play();

    ctx.advance(0.95);
    vi.advanceTimersByTime(TICK_MS);
    expect(ended).not.toHaveBeenCalled();
    // The next tick is due exactly at the end (50 ms), not a full period later.
    ctx.advance(0.05);
    vi.advanceTimersByTime(50);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(engine.isPlaying).toBe(false);
    expect(engine.currentTime).toBe(1);
    expect(times.at(-1)).toBe(1);
    expect(node.lastSegment).toMatchObject({ active: false });

    vi.advanceTimersByTime(1000);
    expect(ended).toHaveBeenCalledTimes(1);

    engine.play();
    expect(node.lastSegment).toMatchObject({ active: true, input: 0 });
  });

  it("clamps the position to the duration when the clock overshoots", async () => {
    f.decoded.buffer = fakeAudioBuffer(2, 48_000);
    const { ctx } = await loaded();
    const ended = vi.fn();
    engine.on("ended", ended);
    engine.play();
    ctx.advance(5);
    expect(engine.currentTime).toBe(1);
    vi.advanceTimersByTime(TICK_MS);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("seeking to the end while playing ends playback", async () => {
    const { ctx } = await loaded();
    const ended = vi.fn();
    engine.on("ended", ended);
    engine.play();
    ctx.advance(1);
    engine.seek(10);
    vi.advanceTimersByTime(1);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe("pitch controls", () => {
  it.each([
    [3.6, 4],
    [-20, -12],
    [13, 12],
    [-0.4, 0],
    [7, 7],
  ])("setSemitones(%s) plays at %s semitones", async (input, expected) => {
    const { node } = await loaded();
    engine.setSemitones(input);
    engine.play();
    expect(Object.is(node.lastSegment.semitones, expected)).toBe(true);
  });

  it.each([
    [60, 0.5],
    [-75, -0.5],
    [12.5, 0.125],
  ])("setCents(%s) plays at %s semitones", async (input, expected) => {
    const { node } = await loaded();
    engine.setCents(input);
    engine.play();
    expect(node.lastSegment.semitones).toBeCloseTo(expected, 12);
  });

  it("rejects non-finite pitch values", () => {
    expect(() => {
      engine.setSemitones(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      engine.setSemitones(Number.NEGATIVE_INFINITY);
    }).toThrow(RangeError);
    expect(() => {
      engine.setCents(Number.NaN);
    }).toThrow(RangeError);
  });

  it("adds cents to semitones", async () => {
    const { node } = await loaded();
    engine.setSemitones(2);
    engine.setCents(-12);
    engine.play();
    expect(node.lastSegment.semitones).toBeCloseTo(1.88, 12);
  });

  it("applies pitch changes while paused on the next play, without scheduling", async () => {
    const { node } = await loaded();
    const count = node.segments.length;
    engine.setSemitones(3);
    vi.advanceTimersByTime(RAMP_MS * 2);
    expect(node.segments).toHaveLength(count);
    engine.play();
    expect(node.lastSegment.semitones).toBe(3);
  });

  it("keeps the pitch setting set before load", async () => {
    engine.setSemitones(-5);
    const { node } = await loaded();
    engine.play();
    expect(node.lastSegment.semitones).toBe(-5);
  });

  it("ramps a live change over RAMP_MS without restarting playback", async () => {
    const { ctx, node } = await loaded();
    engine.play();
    ctx.advance(1);
    const before = node.segments.length;

    engine.setSemitones(4);
    // First step is immediate, so the change is heard at once.
    expect(node.segments).toHaveLength(before + 1);
    // Later steps at 13, 27 and 40 ms (RAMP_MS), with the clock moving too.
    ctx.advance(0.012);
    vi.advanceTimersByTime(12);
    expect(node.segments).toHaveLength(before + 1);
    for (const [ms, count] of [
      [1, 2],
      [14, 3],
      [13, 4],
    ] as const) {
      ctx.advance(ms / 1000);
      vi.advanceTimersByTime(ms);
      expect(node.segments).toHaveLength(before + count);
    }
    const ramp = node.segments.slice(before);
    expect(ramp.map((s) => s.semitones)).toEqual([1, 2, 3, 4]);
    for (const segment of ramp) {
      // Same timeline as the play() anchor (input 0 at output 0): no restart, no jump.
      expect(segment.active).toBe(true);
      expect(segment.rate).toBe(1);
      expect(segment.input).toBeCloseTo(segment.output ?? Number.NaN, 9);
    }
    expect(ramp.at(-1)?.output).toBeCloseTo(1 + RAMP_MS / 1000, 6);
    vi.advanceTimersByTime(RAMP_MS * 2);
    expect(node.segments).toHaveLength(before + 4);
    expect(engine.isPlaying).toBe(true);
    expect(engine.currentTime).toBeCloseTo(1 + RAMP_MS / 1000, 6);
  });

  it("retargets a ramp from wherever it is", async () => {
    const { node } = await loaded();
    engine.play();
    engine.setSemitones(4); // step 1: 1
    vi.advanceTimersByTime(14); // step 2: 2
    const before = node.segments.length;
    engine.setSemitones(0);
    vi.advanceTimersByTime(RAMP_MS);
    expect(node.segments.slice(before).map((s) => s.semitones)).toEqual([
      1.5, 1, 0.5, 0,
    ]);
  });

  it("pausing mid-ramp lands on the target and stops sending steps", async () => {
    const { node } = await loaded();
    engine.play();
    engine.setSemitones(4);
    engine.pause();
    expect(node.lastSegment).toMatchObject({ active: false, semitones: 4 });
    const count = node.segments.length;
    vi.advanceTimersByTime(RAMP_MS * 2);
    expect(node.segments).toHaveLength(count);
  });
});

describe("events", () => {
  it("on() returns an unsubscribe function", async () => {
    const cb = vi.fn();
    const off = engine.on("timeupdate", cb);
    await loaded();
    engine.seek(1);
    expect(cb).toHaveBeenCalledWith(1);
    off();
    off(); // idempotent
    engine.seek(2);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener doesn't break the others or the engine", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const good = vi.fn();
    engine.on("timeupdate", () => {
      throw new Error("listener bug");
    });
    engine.on("timeupdate", good);
    await loaded();
    engine.seek(1);
    expect(good).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalled();
  });

  it("a processor crash stops playback and emits error", async () => {
    const { node } = await loaded();
    const onError = vi.fn();
    const onTime = vi.fn();
    engine.on("error", onError);
    engine.play();
    engine.on("timeupdate", onTime);
    node.dispatch("processorerror");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "EngineError",
        kind: "processor",
        cause: undefined,
      }),
    );
    expect(engine.isPlaying).toBe(false);
    vi.advanceTimersByTime(TICK_MS * 5);
    expect(onTime).not.toHaveBeenCalled();
  });

  it("keeps what an ErrorEvent says about a processor crash", async () => {
    const { node } = await loaded();
    const onError = vi.fn();
    engine.on("error", onError);
    const error = new TypeError("process() threw");
    node.dispatch(
      "processorerror",
      new ErrorEvent("processorerror", { error }),
    );
    node.dispatch(
      "processorerror",
      new ErrorEvent("processorerror", { message: "worklet failed" }),
    );
    node.dispatch("processorerror", new ErrorEvent("processorerror"));
    expect(onError.mock.calls.map(([e]) => (e as EngineError).cause)).toEqual([
      error,
      "worklet failed",
      undefined,
    ]);
  });

  it("a failed AudioContext resume is a playback error, and the next play() tries again", async () => {
    const { ctx } = await loaded();
    const cause = new DOMException("not allowed", "NotAllowedError");
    ctx.resume.mockRejectedValueOnce(cause);
    const onError = vi.fn();
    engine.on("error", onError);
    engine.play();
    await flush();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "playback", cause }),
    );
    expect(engine.isPlaying).toBe(false);

    engine.play();
    await flush();
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(engine.isPlaying).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ignores a resume rejected because dispose() closed the context", async () => {
    const { ctx } = await loaded();
    const resume = deferred<undefined>();
    ctx.resume.mockReturnValueOnce(resume.promise);
    const onError = vi.fn();
    engine.on("error", onError);
    engine.play();
    engine.dispose();
    resume.reject(new DOMException("closed", "InvalidStateError"));
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it("errors while paused are still reported", async () => {
    const { node } = await loaded();
    const onError = vi.fn();
    engine.on("error", onError);
    node.dispatch("processorerror");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("dispose", () => {
  it("stops playback, closes the context and resets state", async () => {
    const { ctx, node } = await loaded();
    const onTime = vi.fn();
    engine.play();
    engine.on("timeupdate", onTime);
    engine.dispose();
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(node.removeEventListener).toHaveBeenCalledWith(
      "processorerror",
      expect.any(Function),
    );
    expect(engine.isPlaying).toBe(false);
    expect(engine.audioBuffer).toBeNull();
    expect(engine.duration).toBe(0);
    expect(engine.currentTime).toBe(0);
    vi.advanceTimersByTime(TICK_MS * 5);
    expect(onTime).not.toHaveBeenCalled();
    engine.play();
    expect(engine.isPlaying).toBe(false);
    engine.dispose();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("can load and play again after dispose (the UI reuses engines this way)", async () => {
    await loaded();
    engine.dispose();
    await engine.load("/media/b.m4a");
    expect(f.contexts).toHaveLength(2);
    expect(f.nodes).toHaveLength(2);
    const ctx = f.contexts[1];
    const node = f.nodes[1];
    if (!ctx || !node) throw new Error("expected a second context and node");
    engine.play();
    expect(node.lastSegment).toMatchObject({
      active: true,
      output: 0,
      input: 0,
    });
    ctx.advance(1);
    expect(engine.currentTime).toBeCloseTo(1, 9);
  });

  it("keeps subscriptions across dispose", async () => {
    const onTime = vi.fn();
    engine.on("timeupdate", onTime);
    await loaded();
    engine.dispose();
    await engine.load("/media/b.m4a");
    engine.seek(1);
    expect(onTime).toHaveBeenCalledWith(1);
  });

  it("aborts an in-flight load", async () => {
    const response = deferred<Response>();
    f.fetch.mockReturnValueOnce(response.promise);
    const pending = engine.load("/media/a.m4a");
    await flush();
    const init = f.fetch.mock.calls[0]?.[1];
    engine.dispose();
    expect(init?.signal?.aborted).toBe(true);
    response.reject(new DOMException("aborted", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(first(f.contexts, "context").close).toHaveBeenCalled();
    expect(engine.audioBuffer).toBeNull();
  });

  it("discards a stretch node that finishes setting up after dispose", async () => {
    const setup = deferred<StretchFactory>();
    f.loadStretch.mockReturnValueOnce(setup.promise);
    const pending = engine.load("/media/a.m4a");
    await flush();
    engine.dispose();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    setup.resolve(f.factory);
    await flush();
    const node = first(f.nodes, "node");
    expect(node.disconnect).toHaveBeenCalled();
    expect(node.connect).not.toHaveBeenCalled();
  });
});

describe("renderOffline", () => {
  it("rejects before anything is loaded", async () => {
    await expect(
      engine.renderOffline({ semitones: 2, cents: 0 }),
    ).rejects.toThrow("no audio is loaded");
  });

  it("renders through a fresh stretch node at the source rate and length", async () => {
    f.decoded.buffer = fakeAudioBuffer(2, 96_000, 44_100);
    await loaded();
    const pct: number[] = [];
    const rendered = await engine.renderOffline({
      semitones: 12,
      cents: -30,
      onProgress: (p) => pct.push(p),
    });

    expect(f.createOfflineContext).toHaveBeenCalledWith(2, 96_000, 44_100);
    const offline = first(f.offline, "offline context");
    const node = f.nodes[1];
    if (!node) throw new Error("expected an offline stretch node");
    expect(node.context).toBe(offline);
    expect(node.options?.outputChannelCount).toEqual([2]);
    expect(node.connect).toHaveBeenCalledWith(offline.destination);
    expect(node.buffers).toHaveLength(2);
    // Identity, not deep equality: the transfer list must be the copies' own
    // ArrayBuffers (and comparing megabytes byte by byte is slow).
    expect(node.transfers).toHaveLength(node.buffers.length);
    (node.transfers ?? []).forEach((transferred, i) => {
      expect(transferred).toBe(node.buffers[i]?.buffer);
    });
    expect(node.segments).toEqual([
      { output: 0, active: true, input: 0, rate: 1, semitones: 11.7 },
    ]);
    expect(rendered.length).toBe(96_000);
    expect(rendered.sampleRate).toBe(44_100);

    expect(pct[0]).toBe(0);
    expect(pct.at(-1)).toBe(100);
    expect(pct.length).toBeGreaterThan(30);
    for (let i = 1; i < pct.length; i++) {
      expect(pct[i]).toBeGreaterThan(pct[i - 1] ?? -1);
    }
    expect(pct.slice(0, -1).every((p) => p < 100)).toBe(true);
    // Checkpoints resume the render every time.
    expect(offline.resume).toHaveBeenCalledTimes(offline.checkpoints.length);
  });

  it("clamps and validates like the live controls", async () => {
    await loaded();
    await engine.renderOffline({ semitones: 20, cents: 80 });
    expect(f.nodes[1]?.segments[0]?.semitones).toBe(12.5);
    await expect(
      engine.renderOffline({ semitones: Number.NaN, cents: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("doesn't disturb live playback", async () => {
    const { ctx, node } = await loaded();
    engine.play();
    ctx.advance(1);
    const count = node.segments.length;
    await engine.renderOffline({ semitones: 3, cents: 0 });
    expect(node.segments).toHaveLength(count);
    expect(engine.isPlaying).toBe(true);
  });

  it("falls back to processor position messages without OfflineAudioContext.suspend", async () => {
    f = fakeDeps({ offlineSuspend: false });
    engine = new Engine(f.deps);
    await loaded();
    const offline = (): FakeStretchNode => {
      const node = f.nodes[1];
      if (!node) throw new Error("expected an offline stretch node");
      return node;
    };
    f.onOffline = (ctx) => {
      ctx.onRender = () => {
        offline().updateCallback?.(5); // halfway through the 10 s track
      };
    };
    const pct: number[] = [];
    await engine.renderOffline({
      semitones: 1,
      cents: 0,
      onProgress: (p) => pct.push(p),
    });
    expect(offline().setUpdateInterval).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Function),
    );
    expect(pct).toEqual([0, 50, 100]);
  });

  it("a throwing progress callback doesn't stall the render", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await loaded();
    const rendered = await engine.renderOffline({
      semitones: 1,
      cents: 0,
      onProgress: (p) => {
        if (p > 0 && p < 100) throw new Error("UI bug");
      },
    });
    expect(rendered.length).toBe(480_000);
    expect(error).toHaveBeenCalled();
  });
});
