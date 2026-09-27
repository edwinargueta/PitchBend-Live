import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineError as ErrorsEngineError } from "./errors";
import { createAudioEngine, EngineError, isEngineError } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAudioEngine", () => {
  it("returns an idle engine that satisfies the contract", () => {
    const engine = createAudioEngine();
    expect(engine.currentTime).toBe(0);
    expect(engine.duration).toBe(0);
    expect(engine.isPlaying).toBe(false);
    expect(engine.audioBuffer).toBeNull();
    expect(typeof engine.on("ended", () => undefined)).toBe("function");
    engine.dispose();
  });

  it("rejects load() cleanly where Web Audio is missing (jsdom)", async () => {
    const engine = createAudioEngine();
    const failure = engine.load("/media/a.m4a");
    await expect(failure).rejects.toThrow(/Web Audio/);
    await expect(failure).rejects.toMatchObject({ kind: "unsupported" });
    engine.dispose();
  });

  it("re-exports the typed engine errors", () => {
    expect(EngineError).toBe(ErrorsEngineError);
    expect(isEngineError(new EngineError("network", "x"))).toBe(true);
  });

  it("wires the browser globals", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("offline")));
    const close = vi.fn(() => Promise.resolve());
    class Ctx {
      readonly audioWorklet = {
        addModule: () => Promise.reject(new Error("no worklet in jsdom")),
      };
      readonly state = "suspended";
      readonly currentTime = 0;
      readonly destination = {};
      readonly close = close;
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn() };
      }
    }
    vi.stubGlobal("AudioContext", Ctx);
    vi.stubGlobal("fetch", fetchSpy);
    const engine = createAudioEngine();
    // The download fails first (the processor chunk is still loading).
    await expect(engine.load("/media/a.m4a")).rejects.toMatchObject({
      kind: "network",
      cause: expect.objectContaining({ message: "offline" }) as Error,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/media/a.m4a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    engine.dispose();
    expect(close).toHaveBeenCalled();
    await expect(
      engine.renderOffline({ semitones: 0, cents: 0 }),
    ).rejects.toThrow("no audio is loaded");
  });
});
