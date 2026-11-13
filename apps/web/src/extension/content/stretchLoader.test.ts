// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import type { StretchFactory } from "signalsmith-stretch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineError } from "../../audio/errors";
import { FakeContext, FakeStretch } from "../testing/fakeAudio";
import {
  createLiveStretch,
  LIVE_STRETCH_CONFIG,
  LIVE_STRETCH_OPTIONS,
  loadStretchFactory,
  withTimeout,
} from "./stretchLoader";

const URL = "chrome-extension://abc/vendor/signalsmith-stretch.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("loadStretchFactory", () => {
  it("should import the packaged file and point moduleUrl at it", async () => {
    const factory = vi.fn() as unknown as StretchFactory;
    const importer = vi.fn(() => Promise.resolve({ default: factory }));
    const loaded = await loadStretchFactory(URL, importer);
    expect(importer).toHaveBeenCalledWith(URL);
    expect(loaded).toBe(factory);
    expect(loaded.moduleUrl).toBe(URL);
  });

  it("should wrap an import failure in an unsupported EngineError", async () => {
    const importer = vi.fn(() => Promise.reject(new Error("CSP")));
    await expect(loadStretchFactory(URL, importer)).rejects.toMatchObject({
      kind: "unsupported",
      message: expect.stringMatching(/couldn't be loaded/) as unknown,
    });
  });

  it.each([null, {}, { default: 42 }])(
    "should reject a module without a factory (%j)",
    async (mod) => {
      await expect(
        loadStretchFactory(URL, () => Promise.resolve(mod)),
      ).rejects.toThrow(/didn't load correctly/);
    },
  );
});

describe("withTimeout", () => {
  it("should resolve with the promise's value in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 50, "late")).resolves.toBe(7);
  });

  it("should reject with an unsupported EngineError when late", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(
      new Promise<never>(() => undefined),
      50,
      "late",
    );
    const check = expect(pending).rejects.toBeInstanceOf(EngineError);
    await vi.advanceTimersByTimeAsync(60);
    await check;
  });
});

describe("createLiveStretch", () => {
  it("should create the node with live options and the low-latency config (AC-3)", async () => {
    const ctx = new FakeContext();
    const stretch = new FakeStretch();
    const factory = vi.fn(() =>
      Promise.resolve(stretch.asNode()),
    ) as unknown as StretchFactory;
    const node = await createLiveStretch(ctx.asContext(), factory);
    expect(node).toBe(stretch);
    expect(factory).toHaveBeenCalledWith(ctx, LIVE_STRETCH_OPTIONS);
    expect(stretch.configure).toHaveBeenCalledWith(LIVE_STRETCH_CONFIG);
    expect(LIVE_STRETCH_CONFIG.blockMs).toBeLessThanOrEqual(60);
  });

  it("should time out when the worklet never reports ready", async () => {
    vi.useFakeTimers();
    const factory = vi.fn(
      () => new Promise<never>(() => undefined),
    ) as unknown as StretchFactory;
    const pending = createLiveStretch(
      new FakeContext().asContext(),
      factory,
      100,
    );
    const check = expect(pending).rejects.toThrow(/didn't start/);
    await vi.advanceTimersByTimeAsync(150);
    await check;
  });
});
