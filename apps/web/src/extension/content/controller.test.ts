// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { describe, expect, it, vi } from "vitest";
import type { TabStatus } from "../shared/protocol";
import { DEFAULT_SETTINGS } from "../shared/tabState";
import { FakeContext, FakeStretch } from "../testing/fakeAudio";
import {
  ContentController,
  createMessageListener,
  GESTURE_COPY,
  NO_VIDEO_COPY,
  onPageGesture,
  restoreSettings,
  siteOf,
  type ControllerDeps,
} from "./controller";
import { LiveGraph } from "./liveGraph";

interface SetupOptions {
  activation?: boolean;
  ctxState?: AudioContextState;
  resume?: "run" | "stay" | "reject";
  failShifter?: boolean;
  /** Leave restore() to the test (by default it runs with nothing saved). */
  fresh?: boolean;
}

function setup(options: SetupOptions = {}) {
  const ctx = new FakeContext(options.ctxState ?? "running");
  ctx.resumeResult = options.resume ?? "run";
  const stretch = new FakeStretch();
  let gesture: (() => void) | null = null;
  const cancelGesture = vi.fn();
  const published: TabStatus[] = [];
  let clock = 1000;
  const log = { warn: vi.fn(), error: vi.fn() };
  const createContext = vi.fn(() => ctx.asContext());
  const createGraph = vi.fn(
    (c: AudioContext) =>
      new LiveGraph(c, () =>
        options.failShifter
          ? Promise.reject(new Error("wasm blocked"))
          : Promise.resolve(stretch.asNode()),
      ),
  );
  const onGesture = vi.fn((callback: () => void) => {
    gesture = callback;
    return cancelGesture;
  });
  const deps: ControllerDeps = {
    site: "youtube",
    createContext,
    createGraph,
    hasActivation: () => options.activation ?? true,
    onGesture,
    publish: (status) => {
      published.push(status);
    },
    now: () => clock++,
    log,
  };
  const controller = new ContentController(deps);
  if (!options.fresh) {
    controller.restore(null);
    published.length = 0;
  }
  const last = (): TabStatus => {
    const status = published.at(-1);
    if (!status) throw new Error("nothing published");
    return status;
  };
  const settle = (state: TabStatus["state"]) =>
    vi.waitFor(() => {
      expect(last().state).toBe(state);
    });
  return {
    ctx,
    stretch,
    createContext,
    createGraph,
    onGesture,
    controller,
    published,
    log,
    cancelGesture,
    last,
    settle,
    gesture: () => gesture?.(),
  };
}

const video = () => document.createElement("video");
const G_MAJOR = { tonic: "G", mode: "major" } as const;

describe("ContentController status", () => {
  it("should start idle with default settings and the site", () => {
    const { controller } = setup();
    expect(controller.handle({ type: "getStatus" })).toEqual({
      state: "idle",
      settings: DEFAULT_SETTINGS,
      site: "youtube",
      shifterMs: null,
      addedMs: null,
      error: null,
      appliedAt: null,
      sentAt: null,
    });
    expect(controller.liveGraph).toBeNull();
  });

  it("should not touch the audio for settings that don't need it", () => {
    const { controller, createContext, last } = setup();
    controller.setVideo(video());
    controller.handle({ type: "setKey", key: G_MAJOR });
    controller.handle({ type: "toggleBypass" });
    expect(createContext).not.toHaveBeenCalled();
    expect(last().state).toBe("idle");
    expect(last().settings.key).toEqual(G_MAJOR);
  });
});

describe("ContentController attach (AC-1, AC-6)", () => {
  it("should attach and run the shifter when the page has activation", async () => {
    const { controller, ctx, stretch, settle, last } = setup();
    controller.setVideo(video());
    controller.handle({ type: "set", semitones: 2 });
    await settle("active");
    expect(stretch.segments.at(-1)).toEqual({ active: true, semitones: 2 });
    expect(ctx.wet.gain.value).toBe(1);
    expect(ctx.dry.gain.value).toBe(0);
    expect(last()).toMatchObject({ shifterMs: 60, addedMs: 70, error: null });
    expect(controller.liveGraph).not.toBeNull();
  });

  it("should wait for a page gesture without creating a context (AC-6)", async () => {
    const { controller, createContext, onGesture, settle, last, gesture } =
      setup({
        activation: false,
      });
    controller.setVideo(video());
    controller.handle({ type: "set", semitones: 2 });
    expect(last()).toMatchObject({
      state: "waiting-gesture",
      error: GESTURE_COPY,
    });
    expect(createContext).not.toHaveBeenCalled();
    controller.handle({ type: "nudge", delta: 1 });
    expect(onGesture).toHaveBeenCalledTimes(1);
    gesture();
    await settle("active");
    expect(last().settings.semitones).toBe(3);
  });

  it("should fall back to a gesture when resume leaves the context suspended", async () => {
    const { controller, ctx, settle, gesture } = setup({
      ctxState: "suspended",
      resume: "stay",
    });
    controller.setVideo(video());
    controller.handle({ type: "set", semitones: 1 });
    await settle("waiting-gesture");
    expect(ctx.sources).toHaveLength(0); // never captured while suspended
    ctx.resumeResult = "run";
    gesture();
    await settle("active");
    expect(ctx.sources).toHaveLength(1);
  });

  it("should log and wait for a gesture when resume rejects", async () => {
    const { controller, settle, log } = setup({
      ctxState: "suspended",
      resume: "reject",
    });
    controller.setVideo(video());
    controller.handle({ type: "set", semitones: 1 });
    await settle("waiting-gesture");
    expect(log.warn).toHaveBeenCalled();
  });

  it("should report no video until one appears", async () => {
    const { controller, last, settle } = setup();
    controller.handle({ type: "set", semitones: 2 });
    expect(last()).toMatchObject({ state: "no-video", error: NO_VIDEO_COPY });
    controller.setVideo(video());
    await settle("active");
  });

  it("should handle the video disappearing before a gesture", async () => {
    const { controller, settle, gesture } = setup({ activation: false });
    controller.setVideo(video());
    controller.handle({ type: "set", semitones: 2 });
    controller.setVideo(null);
    await settle("no-video");
    gesture();
    await settle("no-video");
  });

  it("should keep the audio dry and report why the shifter failed (AC-6)", async () => {
    const { controller, ctx, settle, last, log } = setup({
      failShifter: true,
    });
    controller.setVideo(video());
    controller.handle({ type: "set", semitones: 2 });
    await settle("error");
    expect(last().error).toMatch(/plays without transposing/);
    expect(ctx.dry.gain.value).toBe(1);
    expect(ctx.wet.gain.value).toBe(0);
    expect(log.error).toHaveBeenCalled();
    controller.handle({ type: "set", semitones: 3 }); // retry
    expect(last().state).toBe("starting");
    await settle("error");
  });

  it("should report an element another extension already controls", () => {
    const { controller, ctx, last } = setup();
    ctx.throwOnSource = new Error("InvalidStateError");
    controller.setVideo(video());
    controller.handle({ type: "set", semitones: 2 });
    expect(last()).toMatchObject({ state: "error" });
    expect(last().error).toMatch(/already controls/);
  });
});

describe("ContentController changes while attached", () => {
  async function active() {
    const s = setup();
    s.controller.setVideo(video());
    s.controller.handle({ type: "set", semitones: 2 });
    await s.settle("active");
    return s;
  }

  it("should stamp the applied and sent times of a change (AC-2)", async () => {
    const { controller, last } = await active();
    const status = controller.handle({
      type: "set",
      semitones: 5,
      sentAt: 42,
    });
    expect(status.sentAt).toBe(42);
    expect(status.appliedAt).toBeGreaterThan(1000);
    expect(last().settings.semitones).toBe(5);
  });

  it("should not restamp when the transpose doesn't change", async () => {
    const { controller } = await active();
    const before = controller.status().appliedAt;
    controller.handle({ type: "set", semitones: 2, sentAt: 7 });
    expect(controller.status().appliedAt).toBe(before);
  });

  it("should crossfade to dry for bypass and back (AC-7)", async () => {
    const { controller, ctx } = await active();
    controller.handle({ type: "setBypass", on: true });
    expect(ctx.dry.gain.value).toBe(1);
    expect(ctx.wet.gain.value).toBe(0);
    controller.handle({ type: "toggleBypass" });
    expect(ctx.wet.gain.value).toBe(1);
  });

  it("should play the original, dry, at 0", async () => {
    const { controller, ctx, last } = await active();
    controller.handle({ type: "reset" });
    expect(ctx.dry.gain.value).toBe(1);
    expect(last().settings.bypass).toBe(false);
    expect(last().addedMs).toBe(10);
  });

  it("should attach a replacement element to the same graph", async () => {
    const { controller, ctx, createGraph } = await active();
    controller.setVideo(video());
    expect(ctx.sources).toHaveLength(2);
    expect(createGraph).toHaveBeenCalledTimes(1);
  });

  it("should report a replacement element that can't be captured", async () => {
    const { controller, ctx, last } = await active();
    ctx.throwOnSource = new Error("taken");
    controller.setVideo(video());
    expect(last().state).toBe("error");
  });

  it("should keep its state when the video goes away while attached", async () => {
    const { controller, last } = await active();
    controller.setVideo(null);
    expect(last().state).toBe("active");
  });

  it("should clear the key on a new video and keep the transpose (AC-8)", async () => {
    const { controller, last } = await active();
    controller.handle({ type: "setKey", key: G_MAJOR });
    controller.videoChanged();
    expect(last().settings).toEqual({
      semitones: 2,
      bypass: false,
      key: null,
    });
  });

  it("should log schedule failures", async () => {
    const { controller, stretch, log } = await active();
    stretch.scheduleError = new Error("port closed");
    controller.handle({ type: "set", semitones: 4 });
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalled();
    });
  });

  it("should dispose the graph and any pending gesture", async () => {
    const { controller } = await active();
    expect(() => {
      controller.dispose();
    }).not.toThrow();
    const waiting = setup({ activation: false });
    waiting.controller.setVideo(video());
    waiting.controller.handle({ type: "set", semitones: 1 });
    waiting.controller.dispose();
    expect(waiting.cancelGesture).toHaveBeenCalled();
  });
});

describe("ContentController.restore (FR-7)", () => {
  it("should apply saved settings and attach when they transpose", async () => {
    const { controller, settle, last } = setup({ fresh: true });
    controller.setVideo(video());
    controller.restore({ semitones: 3, bypass: false, key: G_MAJOR });
    await settle("active");
    expect(last().settings.key).toEqual(G_MAJOR);
  });

  it("should publish nothing until restored, so defaults can't overwrite the save", () => {
    const { controller, published, last } = setup({ fresh: true });
    controller.setVideo(video());
    controller.videoChanged();
    expect(published).toHaveLength(0);
    controller.restore(null);
    expect(published).toHaveLength(1);
    expect(last().settings).toEqual(DEFAULT_SETTINGS);
  });

  it("should keep a command that arrived before the saved settings", () => {
    const { controller, last } = setup({ fresh: true, activation: false });
    controller.setVideo(video());
    controller.handle({ type: "set", semitones: 2 });
    controller.restore({ semitones: 5, bypass: false, key: null });
    expect(last().settings.semitones).toBe(2);
    expect(last().state).toBe("waiting-gesture");
  });

  it("should restore only once", () => {
    const { controller } = setup();
    controller.restore({ semitones: 5, bypass: false, key: null });
    expect(controller.status().settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("createMessageListener", () => {
  it("should answer valid commands from the extension only", () => {
    const { controller } = setup();
    const listener = createMessageListener(controller, "ext-id");
    const sendResponse = vi.fn();
    expect(
      listener({ type: "getStatus" }, { id: "ext-id" }, sendResponse),
    ).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ state: "idle" }),
    );
    sendResponse.mockClear();
    listener({ type: "getStatus" }, { id: "other" }, sendResponse);
    listener({ type: "set", semitones: "2" }, { id: "ext-id" }, sendResponse);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe("restoreSettings", () => {
  it("should restore valid saved settings", async () => {
    const { controller } = setup({ fresh: true });
    const runtime = {
      sendMessage: vi.fn(() =>
        Promise.resolve({ semitones: -2, bypass: true, key: null }),
      ),
    };
    await restoreSettings(runtime, controller, {
      warn: vi.fn(),
      error: vi.fn(),
    });
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: "restoreRequest",
    });
    expect(controller.status().settings).toEqual({
      semitones: -2,
      bypass: true,
      key: null,
    });
  });

  it("should start publishing the defaults when nothing was saved", async () => {
    const { controller, published } = setup({ fresh: true });
    await restoreSettings(
      { sendMessage: () => Promise.resolve(undefined) },
      controller,
      { warn: vi.fn(), error: vi.fn() },
    );
    expect(published).toEqual([
      expect.objectContaining({ state: "idle", settings: DEFAULT_SETTINGS }),
    ]);
  });

  it("should log and still start publishing when the worker can't answer", async () => {
    const { controller, published } = setup({ fresh: true });
    const log = { warn: vi.fn(), error: vi.fn() };
    await restoreSettings(
      { sendMessage: () => Promise.reject(new Error("no worker")) },
      controller,
      log,
    );
    expect(log.warn).toHaveBeenCalled();
    expect(published).toHaveLength(1);
  });
});

describe("onPageGesture", () => {
  it("should fire once on the first pointerdown or keydown", () => {
    const callback = vi.fn();
    onPageGesture(window, callback);
    window.dispatchEvent(new Event("keydown"));
    window.dispatchEvent(new Event("pointerdown"));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("should not fire after cancel", () => {
    const callback = vi.fn();
    const cancel = onPageGesture(window, callback);
    cancel();
    window.dispatchEvent(new Event("pointerdown"));
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("siteOf", () => {
  it.each([
    ["www.youtube.com", "youtube"],
    ["music.youtube.com", "music"],
    ["m.youtube.com", null],
    ["example.com", null],
  ])("%s → %s", (host, site) => {
    expect(siteOf(host)).toBe(site);
  });
});
