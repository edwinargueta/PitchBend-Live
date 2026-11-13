// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineError } from "../../audio/errors";
import { FakeContext, FakeStretch } from "../testing/fakeAudio";
import { CROSSFADE_S, LiveGraph } from "./liveGraph";

const video = () => document.createElement("video");

function setup(options: { fail?: unknown } = {}) {
  const ctx = new FakeContext();
  const stretch = new FakeStretch();
  const startNode = vi.fn(() =>
    options.fail === undefined
      ? Promise.resolve(stretch.asNode())
      : Promise.reject(
          options.fail instanceof Error ? options.fail : new Error("x"),
        ),
  );
  const graph = new LiveGraph(ctx.asContext(), startNode);
  return { ctx, stretch, startNode, graph };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveGraph construction", () => {
  it("should wire dry at full gain and wet at zero to the destination", () => {
    const { ctx, graph } = setup();
    expect(ctx.dry.gain.value).toBe(1);
    expect(ctx.wet.gain.value).toBe(0);
    expect(ctx.dry.connections).toContain(ctx.destination);
    expect(ctx.wet.connections).toContain(ctx.destination);
    expect(graph.context).toBe(ctx);
    expect(graph.addedMs).toBeNull();
    expect(graph.shifterMs).toBeNull();
    expect(graph.shifterReady).toBe(false);
  });
});

describe("LiveGraph.attach (FR-9 never silent)", () => {
  it("should connect the captured element to the dry path immediately", () => {
    const { ctx, graph } = setup();
    expect(graph.attach(video()).ok).toBe(true);
    const source = ctx.sources[0];
    expect(source?.connections).toEqual([ctx.dry]);
    expect(graph.addedMs).toBe(10); // base latency only, wet not live
  });

  it("should be idempotent per element", () => {
    const { ctx, graph } = setup();
    const el = video();
    graph.attach(el);
    graph.attach(el);
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("should return an error and build nothing when the element can't be captured", () => {
    const { ctx, graph } = setup();
    ctx.throwOnSource = new DOMException("taken", "InvalidStateError");
    const result = graph.attach(video());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EngineError);
      expect(result.error.message).toMatch(/already controls/);
    }
    expect(graph.addedMs).toBeNull();
  });

  it("should connect a second element to the dry path and the running shifter", async () => {
    const { ctx, stretch, graph } = setup();
    graph.attach(video());
    await graph.startShifter();
    graph.attach(video());
    expect(ctx.sources[1]?.connections).toEqual([ctx.dry, stretch]);
    expect(ctx.sources[0]?.disconnect).not.toHaveBeenCalled();
  });
});

describe("LiveGraph.startShifter", () => {
  it("should connect the shifter, apply the remembered shift and fade to wet (AC-1)", async () => {
    const { ctx, stretch, graph } = setup();
    graph.attach(video());
    graph.setShift(2);
    const result = await graph.startShifter();
    expect(result).toEqual({ ok: true, value: 0.06 });
    expect(stretch.connections).toEqual([ctx.wet]);
    expect(ctx.sources[0]?.connections).toEqual([ctx.dry, stretch]);
    expect(stretch.segments).toEqual([{ active: true, semitones: 2 }]);
    expect(ctx.dry.gain.ramps.at(-1)).toEqual({
      value: 0,
      time: 1 + CROSSFADE_S,
    });
    expect(ctx.wet.gain.ramps.at(-1)).toEqual({
      value: 1,
      time: 1 + CROSSFADE_S,
    });
    expect(graph.shifterReady).toBe(true);
    expect(graph.target).toBe(2);
  });

  it("should report the added delay as shifter + base latency (AC-3)", async () => {
    const { ctx, graph } = setup();
    graph.attach(video());
    await graph.startShifter();
    expect(graph.shifterMs).toBe(60);
    expect(graph.addedMs).toBe(70);
    ctx.baseLatency = undefined;
    expect(graph.addedMs).toBe(60);
  });

  it("should start once even when asked twice", async () => {
    const { startNode, graph } = setup();
    const [a, b] = await Promise.all([
      graph.startShifter(),
      graph.startShifter(),
    ]);
    expect(a).toBe(b);
    expect(startNode).toHaveBeenCalledTimes(1);
  });

  it("should keep the dry path and allow a retry when the shifter fails (AC-6)", async () => {
    const { ctx, startNode, graph } = setup({ fail: new Error("no wasm") });
    graph.attach(video());
    const result = await graph.startShifter();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("processor");
      expect(result.error.message).toMatch(/couldn't start/);
    }
    expect(ctx.dry.gain.value).toBe(1);
    expect(ctx.wet.gain.value).toBe(0);
    expect(ctx.wet.gain.ramps).toEqual([]);
    await graph.startShifter();
    expect(startNode).toHaveBeenCalledTimes(2);
  });

  it("should keep an EngineError's own kind", async () => {
    const { graph } = setup({
      fail: new EngineError("unsupported", "timed out", { hint: "no-wasm" }),
    });
    const result = await graph.startShifter();
    expect(!result.ok && result.error.kind).toBe("unsupported");
  });
});

describe("LiveGraph.setShift (AC-2)", () => {
  it("should ramp a live change in steps, the first one immediately", async () => {
    const { stretch, graph } = setup();
    graph.attach(video());
    await graph.startShifter();
    graph.setShift(4);
    expect(stretch.segments.length).toBe(2); // initial 0 + first step
    expect(stretch.lastSemitones).toBe(1);
    vi.advanceTimersByTime(100);
    expect(stretch.lastSemitones).toBe(4);
  });

  it("should pass schedule rejections to the error handler", async () => {
    const { stretch, graph } = setup();
    const handler = vi.fn();
    graph.scheduleErrorHandler = handler;
    await graph.startShifter();
    stretch.scheduleError = new Error("port closed");
    graph.setShift(1);
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
  });

  it("should swallow schedule rejections when no handler is set", async () => {
    const { stretch, graph } = setup();
    await graph.startShifter();
    stretch.scheduleError = "odd";
    graph.setShift(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(stretch.schedule).toHaveBeenCalled();
  });
});

describe("LiveGraph.setBypass (AC-7)", () => {
  it("should crossfade to dry and back", async () => {
    const { ctx, graph } = setup();
    graph.attach(video());
    await graph.startShifter();
    graph.setBypass(true);
    expect(graph.bypass).toBe(true);
    expect(ctx.dry.gain.value).toBe(1);
    expect(ctx.wet.gain.value).toBe(0);
    expect(graph.addedMs).toBe(10); // no shifter latency while bypassed
    graph.setBypass(false);
    expect(ctx.dry.gain.value).toBe(0);
    expect(ctx.wet.gain.value).toBe(1);
    expect(ctx.dry.gain.cancelScheduledValues).toHaveBeenCalled();
  });

  it("should stay dry when bypass is on before the shifter starts", async () => {
    const { ctx, graph } = setup();
    graph.attach(video());
    graph.setBypass(true);
    await graph.startShifter();
    expect(ctx.dry.gain.value).toBe(1);
    expect(ctx.wet.gain.value).toBe(0);
  });
});

describe("LiveGraph.dispose", () => {
  it("should be safe before the shifter starts", () => {
    const { graph } = setup();
    graph.setShift(3);
    expect(() => {
      graph.dispose();
    }).not.toThrow();
    expect(graph.target).toBe(3);
  });

  it("should cancel ramps but never close the context or disconnect sources", async () => {
    const { ctx, stretch, graph } = setup();
    graph.attach(video());
    await graph.startShifter();
    graph.setShift(6);
    graph.dispose();
    const before = stretch.segments.length;
    vi.advanceTimersByTime(100);
    expect(stretch.segments.length).toBe(before);
    expect(ctx.close).not.toHaveBeenCalled();
    expect(ctx.sources[0]?.disconnect).not.toHaveBeenCalled();
  });
});
