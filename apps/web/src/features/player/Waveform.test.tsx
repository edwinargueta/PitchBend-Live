import { act, render, screen, waitFor } from "@testing-library/react";
import type WaveSurfer from "wavesurfer.js";
import type { WaveSurferOptions } from "wavesurfer.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBuffer } from "../__tests__/fakeEngine";
import { readWaveColors } from "./waveColors";
import { Waveform } from "./Waveform";

const { create } = vi.hoisted(() => ({
  create: vi.fn<(options: WaveSurferOptions) => WaveSurfer>(),
}));
vi.mock("wavesurfer.js", () => ({ default: { create } }));

type Handler = (...args: unknown[]) => void;

let handlers: Record<string, Handler>;
let fakeWs: {
  on: ReturnType<typeof vi.fn>;
  setTime: ReturnType<typeof vi.fn>;
  setMuted: ReturnType<typeof vi.fn>;
  setOptions: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
let lastOptions: WaveSurferOptions | undefined;

function fire(event: string, ...args: unknown[]) {
  act(() => {
    handlers[event]?.(...args);
  });
}

beforeEach(() => {
  handlers = {};
  lastOptions = undefined;
  fakeWs = {
    on: vi.fn((event: string, cb: Handler) => {
      handlers[event] = cb;
      return () => undefined;
    }),
    setTime: vi.fn(),
    setMuted: vi.fn(),
    setOptions: vi.fn(),
    destroy: vi.fn(),
  };
  create.mockReset();
  create.mockImplementation((options) => {
    lastOptions = options;
    return fakeWs as unknown as WaveSurfer;
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
});

describe("Waveform", () => {
  it("is fed peaks + duration from the decoded buffer, never a URL, and can't play", async () => {
    const buffer = fakeBuffer(120);
    render(<Waveform buffer={buffer} currentTime={0} onSeek={vi.fn()} />);
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    expect(lastOptions?.url).toBeUndefined();
    expect(lastOptions?.media).toBeUndefined();
    expect(lastOptions?.duration).toBe(120);
    expect(lastOptions?.peaks).toHaveLength(1);
    expect(lastOptions?.peaks?.[0]?.length).toBeGreaterThan(0);
    expect(lastOptions?.autoplay).toBe(false);
    expect(lastOptions?.dragToSeek).toBe(true);
    expect(lastOptions?.container).toBe(screen.getByTestId("waveform"));
    expect(fakeWs.setMuted).toHaveBeenCalledWith(true);
    expect(screen.getByTestId("waveform")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("follows the engine's time once ready", async () => {
    const buffer = fakeBuffer();
    const { rerender } = render(
      <Waveform buffer={buffer} currentTime={5} onSeek={vi.fn()} />,
    );
    await waitFor(() => {
      expect(create).toHaveBeenCalled();
    });
    expect(fakeWs.setTime).not.toHaveBeenCalled();
    fire("ready", 180);
    expect(fakeWs.setTime).toHaveBeenLastCalledWith(5);
    rerender(<Waveform buffer={buffer} currentTime={9} onSeek={vi.fn()} />);
    expect(fakeWs.setTime).toHaveBeenLastCalledWith(9);
  });

  it("a click seeks the engine", async () => {
    const onSeek = vi.fn();
    render(<Waveform buffer={fakeBuffer()} currentTime={0} onSeek={onSeek} />);
    await waitFor(() => {
      expect(create).toHaveBeenCalled();
    });
    fire("interaction", 33.3);
    expect(onSeek).toHaveBeenCalledWith(33.3);
  });

  it("a drag seeks once, at the end, and ignores engine time while dragging", async () => {
    const onSeek = vi.fn();
    const buffer = fakeBuffer(200);
    const { rerender } = render(
      <Waveform buffer={buffer} currentTime={0} onSeek={onSeek} />,
    );
    await waitFor(() => {
      expect(create).toHaveBeenCalled();
    });
    fire("ready", 200);
    fakeWs.setTime.mockClear();

    fire("dragstart", 0.1);
    fire("interaction", 20);
    rerender(<Waveform buffer={buffer} currentTime={1} onSeek={onSeek} />);
    expect(onSeek).not.toHaveBeenCalled();
    expect(fakeWs.setTime).not.toHaveBeenCalled();

    fire("dragend", 0.5);
    expect(onSeek).toHaveBeenCalledWith(100);
  });

  it("falls back to a plain bar if wavesurfer errors or fails to load", async () => {
    render(<Waveform buffer={fakeBuffer()} currentTime={0} onSeek={vi.fn()} />);
    await waitFor(() => {
      expect(create).toHaveBeenCalled();
    });
    fire("error", new Error("bad"));
    expect(screen.getByTestId("waveform")).toHaveClass("waveform--failed");
  });

  it("falls back when creation throws", async () => {
    create.mockImplementation(() => {
      throw new Error("no canvas");
    });
    render(<Waveform buffer={fakeBuffer()} currentTime={0} onSeek={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("waveform")).toHaveClass("waveform--failed");
    });
  });

  it("re-colours on a light/dark switch and cleans up on unmount", async () => {
    let onSchemeChange: (() => void) | undefined;
    const removeEventListener = vi.fn();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: (_: string, cb: () => void) => {
          onSchemeChange = cb;
        },
        removeEventListener,
      })),
    });
    const { unmount } = render(
      <Waveform buffer={fakeBuffer()} currentTime={0} onSeek={vi.fn()} />,
    );
    await waitFor(() => {
      expect(onSchemeChange).toBeDefined();
    });
    act(() => {
      onSchemeChange?.();
    });
    expect(fakeWs.setOptions).toHaveBeenCalledWith(
      expect.objectContaining({ waveColor: expect.any(String) as string }),
    );
    unmount();
    expect(fakeWs.destroy).toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalled();
  });

  it("a new buffer replaces the waveform", async () => {
    const { rerender } = render(
      <Waveform buffer={fakeBuffer(10)} currentTime={0} onSeek={vi.fn()} />,
    );
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    rerender(
      <Waveform buffer={fakeBuffer(20)} currentTime={0} onSeek={vi.fn()} />,
    );
    expect(fakeWs.destroy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
    });
    expect(lastOptions?.duration).toBe(20);
  });

  it("an unmount before wavesurfer loads never creates it", async () => {
    const { unmount } = render(
      <Waveform buffer={fakeBuffer()} currentTime={0} onSeek={vi.fn()} />,
    );
    unmount();
    await act(async () => {
      await import("wavesurfer.js");
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("readWaveColors", () => {
  it("reads themed custom properties, with fallbacks", () => {
    const el = document.createElement("div");
    document.body.append(el);
    expect(readWaveColors(el)).toEqual({
      waveColor: "#9ca3af",
      progressColor: "#4338ca",
      cursorColor: "#4338ca",
    });
    const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) =>
        name === "--wave" ? " #123456 " : "",
    } as CSSStyleDeclaration);
    expect(readWaveColors(el).waveColor).toBe("#123456");
    spy.mockRestore();
    el.remove();
  });
});
