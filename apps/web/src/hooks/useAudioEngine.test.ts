import { act, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import * as audio from "../audio";
import { EngineError } from "../audio/errors";
import { deferred, FakeEngine } from "../features/__tests__/fakeEngine";
import { useAudioEngine } from "./useAudioEngine";

vi.mock("../audio", () => ({ createAudioEngine: vi.fn(), encodeWav: vi.fn() }));
const { loadAudioModule } = vi.hoisted(() => ({
  loadAudioModule: vi.fn<() => Promise<typeof import("../audio")>>(),
}));
vi.mock("./audioModule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audioModule")>();
  loadAudioModule.mockImplementation(actual.loadAudioModule);
  return { loadAudioModule };
});

const createAudioEngine = vi.mocked(audio.createAudioEngine);
let engine: FakeEngine;
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  engine = new FakeEngine();
  createAudioEngine.mockImplementation(() => engine);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

async function readyHook(url = "/media/a.m4a") {
  const hook = renderHook(() => useAudioEngine(url));
  await waitFor(() => {
    expect(hook.result.current.status).toBe("ready");
  });
  return hook;
}

describe("useAudioEngine", () => {
  it("lazily creates one engine, loads the URL with progress, then is ready", async () => {
    const load = deferred<undefined>();
    let report: ((pct: number) => void) | undefined;
    engine.load.mockImplementation((_url, onProgress) => {
      report = onProgress;
      return load.promise;
    });
    const { result } = renderHook(() => useAudioEngine("/media/a.m4a", 99));
    expect(result.current.status).toBe("loading");
    expect(result.current.duration).toBe(99);
    expect(result.current.engine).toBeNull();

    await waitFor(() => {
      expect(engine.load).toHaveBeenCalledWith(
        "/media/a.m4a",
        expect.any(Function),
      );
    });
    act(() => {
      report?.(60);
    });
    expect(result.current.loadPct).toBe(60);

    engine.audioBuffer = { duration: 180 } as AudioBuffer;
    await act(async () => {
      load.resolve(undefined);
      await load.promise;
    });
    expect(createAudioEngine).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    expect(result.current.engine).toBe(engine);
    expect(result.current.duration).toBe(180);
    expect(result.current.audioBuffer).toBe(engine.audioBuffer);
  });

  it("play, pause, toggle and seek drive the engine", async () => {
    const { result } = renderHook(() => useAudioEngine("/media/a.m4a"));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    act(() => {
      result.current.play();
    });
    expect(engine.play).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);

    act(() => {
      result.current.pause();
    });
    expect(result.current.isPlaying).toBe(false);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.isPlaying).toBe(true);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.isPlaying).toBe(false);

    act(() => {
      result.current.seek(42.5);
    });
    expect(engine.seek).toHaveBeenCalledWith(42.5);
    expect(result.current.currentTime).toBe(42.5);

    act(() => {
      result.current.seek(-5);
    });
    expect(engine.seek).toHaveBeenLastCalledWith(0);
    act(() => {
      result.current.seek(999);
    });
    expect(engine.seek).toHaveBeenLastCalledWith(180);
  });

  it("controls are no-ops until the engine is ready", () => {
    engine.load.mockImplementation(() => new Promise<void>(() => undefined));
    const { result } = renderHook(() => useAudioEngine("/media/a.m4a"));
    act(() => {
      result.current.play();
      result.current.pause();
      result.current.toggle();
      result.current.seek(3);
    });
    expect(engine.play).not.toHaveBeenCalled();
    expect(engine.seek).not.toHaveBeenCalled();
  });

  it("follows timeupdate and ended events", async () => {
    const { result } = renderHook(() => useAudioEngine("/media/a.m4a"));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    act(() => {
      engine.currentTime = 12;
      engine.isPlaying = true;
      engine.emit("timeupdate", 12);
    });
    expect(result.current.currentTime).toBe(12);
    expect(result.current.isPlaying).toBe(true);
    act(() => {
      engine.isPlaying = false;
      engine.currentTime = 180;
      engine.emit("ended");
    });
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTime).toBe(180);
  });

  it("keeps a load failure's EngineError (not swallowed) and logs it once", async () => {
    const cause = new DOMException("Unable to decode", "EncodingError");
    const err = new EngineError("decode", "No AAC.", { cause, hint: "no-aac" });
    engine.load.mockRejectedValueOnce(err);
    const { result } = renderHook(() => useAudioEngine("/media/bad.m4a"));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toBe(err);
    expect(result.current.engine).toBeNull();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("[audio] decode error: No AAC.", {
      kind: "decode",
      hint: "no-aac",
      cause,
    });
  });

  it("wraps an unclassified failure as a processor error", async () => {
    const cause = new Error("decode failed");
    engine.load.mockRejectedValueOnce(cause);
    const { result } = renderHook(() => useAudioEngine("/media/bad.m4a"));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toMatchObject({ kind: "processor", cause });
  });

  it("an unexpected AbortError is a failure too, so nothing spins forever", async () => {
    engine.load.mockRejectedValueOnce(new DOMException("x", "AbortError"));
    const { result } = renderHook(() => useAudioEngine("/media/a.m4a"));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error?.kind).toBe("processor");
  });

  it("a failed engine download is a network error", async () => {
    const cause = new TypeError("Failed to fetch dynamically imported module");
    loadAudioModule.mockRejectedValueOnce(cause);
    const { result } = renderHook(() => useAudioEngine("/media/a.m4a"));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toMatchObject({ kind: "network", cause });
    expect(createAudioEngine).not.toHaveBeenCalled();
  });

  it("an engine error event after load → error status with that error", async () => {
    const { result } = await readyHook();
    const crash = new EngineError("processor", "The worklet crashed.");
    act(() => {
      engine.isPlaying = false;
      engine.emit("error", crash);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe(crash);
    expect(result.current.engine).toBeNull();
    // Later failures are fallout: the first one stays.
    act(() => {
      engine.emit("error", new EngineError("processor", "Again."));
    });
    expect(result.current.error).toBe(crash);
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it("an error event during the load wins over the load finishing", async () => {
    const load = deferred<undefined>();
    engine.load.mockImplementation(() => load.promise);
    const { result } = renderHook(() => useAudioEngine("/media/a.m4a"));
    await waitFor(() => {
      expect(engine.load).toHaveBeenCalled();
    });
    act(() => {
      engine.emit("error", new Error("worklet crashed"));
    });
    expect(result.current.status).toBe("error");
    await act(async () => {
      load.resolve(undefined);
      await load.promise;
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error?.kind).toBe("processor");
  });

  it("a playback error keeps the player usable, and Play clears it", async () => {
    const { result } = await readyHook();
    act(() => {
      result.current.play();
    });
    const blocked = new EngineError("playback", "Not allowed.");
    act(() => {
      engine.isPlaying = false;
      engine.emit("error", blocked);
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.engine).toBe(engine);
    expect(result.current.error).toBe(blocked);
    expect(result.current.isPlaying).toBe(false);

    // Pausing or seeking doesn't hide it; starting playback does.
    act(() => {
      result.current.pause();
      result.current.seek(3);
    });
    expect(result.current.error).toBe(blocked);
    act(() => {
      result.current.play();
    });
    expect(engine.play).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.isPlaying).toBe(true);

    act(() => {
      result.current.pause();
      engine.emit("error", blocked);
    });
    act(() => {
      result.current.toggle();
    });
    expect(result.current.error).toBeNull();
    act(() => {
      engine.emit("error", blocked);
    });
    act(() => {
      result.current.toggle(); // pausing: keeps the error
    });
    expect(result.current.error).toBe(blocked);
  });

  it("retry() disposes the failed engine and loads the same URL into a new one", async () => {
    const failed = engine;
    failed.load.mockRejectedValueOnce(new EngineError("network", "HTTP 503."));
    const { result } = renderHook(() => useAudioEngine("/media/a.m4a", 99));
    await waitFor(() => {
      expect(result.current.error?.kind).toBe("network");
    });
    const fresh = new FakeEngine();
    createAudioEngine.mockImplementation(() => fresh);
    act(() => {
      result.current.retry();
    });
    expect(failed.dispose).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("loading");
    expect(result.current.error).toBeNull();
    expect(result.current.duration).toBe(99);
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.engine).toBe(fresh);
    expect(fresh.load).toHaveBeenCalledWith(
      "/media/a.m4a",
      expect.any(Function),
    );
    expect(createAudioEngine).toHaveBeenCalledTimes(2);
    // The old engine's listeners are gone: its late events change nothing.
    expect(failed.listenerCount("error")).toBe(0);
  });

  it("doesn't report a failure that lands after unmount", async () => {
    const load = deferred<undefined>();
    engine.load.mockImplementation(() => load.promise);
    const { result, unmount } = renderHook(() =>
      useAudioEngine("/media/a.m4a"),
    );
    await waitFor(() => {
      expect(engine.load).toHaveBeenCalled();
    });
    unmount();
    await act(async () => {
      load.reject(new EngineError("network", "Gone."));
      await load.promise.catch(() => undefined);
    });
    expect(result.current.status).toBe("loading");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("disposes the engine on unmount and removes its listeners", async () => {
    const { result, unmount } = renderHook(() =>
      useAudioEngine("/media/a.m4a"),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(engine.listenerCount("timeupdate")).toBe(1);
    unmount();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(engine.listenerCount("timeupdate")).toBe(0);
  });

  it("replacing the URL disposes the old engine and loads a new one", async () => {
    const first = engine;
    const { result, rerender } = renderHook(({ url }) => useAudioEngine(url), {
      initialProps: { url: "/media/a.m4a" },
    });
    await waitFor(() => {
      expect(result.current.engine).toBe(first);
    });
    const second = new FakeEngine();
    createAudioEngine.mockImplementation(() => second);
    rerender({ url: "/media/b.m4a" });
    expect(first.dispose).toHaveBeenCalled();
    expect(result.current.status).toBe("loading");
    await waitFor(() => {
      expect(result.current.engine).toBe(second);
    });
    expect(second.load).toHaveBeenCalledWith(
      "/media/b.m4a",
      expect.any(Function),
    );
  });

  it("an unmount mid-load disposes the engine and ignores the late result", async () => {
    const load = deferred<undefined>();
    engine.load.mockImplementation(() => load.promise);
    const { result, unmount } = renderHook(() =>
      useAudioEngine("/media/a.m4a"),
    );
    await waitFor(() => {
      expect(engine.load).toHaveBeenCalled();
    });
    unmount();
    expect(engine.dispose).toHaveBeenCalled();
    await act(async () => {
      load.resolve(undefined);
      await load.promise;
    });
    expect(result.current.status).toBe("loading");
  });
});
