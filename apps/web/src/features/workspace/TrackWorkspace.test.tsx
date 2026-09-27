import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type WaveSurfer from "wavesurfer.js";
import type { WaveSurferOptions } from "wavesurfer.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as audio from "../../audio";
import { EngineError } from "../../audio/errors";
import type { KeyState, SessionTrack } from "../../hooks/sessionReducer";
import { deferred, FakeEngine } from "../__tests__/fakeEngine";
import { KEY_G } from "../__tests__/fakeLib";
import { downloadBlob } from "../export/download";
import TrackWorkspace from "./TrackWorkspace";

vi.mock("../../audio", () => ({
  createAudioEngine: vi.fn(),
  encodeWav: vi.fn(),
}));
vi.mock(
  "../../lib/music",
  async () => (await import("../__tests__/fakeLib")).fakeMusic,
);
vi.mock("../export/download", () => ({ downloadBlob: vi.fn() }));
const { createWaveSurfer } = vi.hoisted(() => ({
  createWaveSurfer: vi.fn<(options: WaveSurferOptions) => WaveSurfer>(),
}));
vi.mock("wavesurfer.js", () => ({ default: { create: createWaveSurfer } }));

type Handler = (...a: unknown[]) => void;

const TRACK: SessionTrack = {
  trackId: "trk-1",
  audioUrl: "/media/abc.m4a",
  title: "My Song",
  durationS: 180,
};
const READY: KeyState = { status: "ready", info: KEY_G };
const PENDING: KeyState = { status: "pending", info: null };

let engine: FakeEngine;
let wsHandlers: Record<string, Handler>;
const onStartOver = vi.fn();

function setup(keyState: KeyState = READY, track: SessionTrack = TRACK) {
  const view = render(
    <TrackWorkspace
      track={track}
      keyState={keyState}
      onStartOver={onStartOver}
    />,
  );
  return view;
}

async function ready() {
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  engine = new FakeEngine();
  vi.mocked(audio.createAudioEngine).mockImplementation(() => engine);
  vi.mocked(audio.encodeWav).mockReturnValue(new Blob(["RIFF"]));
  wsHandlers = {};
  createWaveSurfer.mockImplementation(
    () =>
      ({
        on: (event: string, cb: Handler) => {
          wsHandlers[event] = cb;
          return () => undefined;
        },
        setTime: vi.fn(),
        setMuted: vi.fn(),
        setOptions: vi.fn(),
        destroy: vi.fn(),
      }) as unknown as WaveSurfer,
  );
});

describe("TrackWorkspace", () => {
  it("loads the track into a lazily created engine and shows the player", async () => {
    setup();
    expect(
      screen.getByRole("heading", { name: "My Song" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Loading audio…")).toHaveAttribute(
      "role",
      "status",
    );
    await ready();
    expect(audio.createAudioEngine).toHaveBeenCalledTimes(1);
    expect(engine.load).toHaveBeenCalledWith(
      "/media/abc.m4a",
      expect.any(Function),
    );
    // Settings are (re)applied as soon as the engine is ready.
    expect(engine.setSemitones).toHaveBeenCalledWith(0);
    expect(engine.setCents).toHaveBeenCalledWith(0);
  });

  it("draws the waveform from the engine's decoded buffer and seeks the engine", async () => {
    setup();
    await ready();
    await waitFor(() => {
      expect(createWaveSurfer).toHaveBeenCalled();
    });
    const options = createWaveSurfer.mock.calls[0]?.[0];
    expect(options?.url).toBeUndefined();
    expect(options?.duration).toBe(engine.audioBuffer?.duration);
    act(() => {
      wsHandlers.interaction?.(42);
    });
    expect(engine.seek).toHaveBeenCalledWith(42);
  });

  it("every dial change goes straight to engine.setSemitones", async () => {
    setup();
    await ready();
    engine.setSemitones.mockClear();
    const dial = screen.getByRole("slider", { name: "Transpose" });
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(engine.setSemitones).toHaveBeenCalledWith(1);
    expect(dial).toHaveAttribute("aria-valuenow", "1");
    expect(dial).toHaveAttribute(
      "aria-valuetext",
      "Plus 1 semitone, G sharp major",
    );
    expect(screen.getByText("Now:").closest("p")).toHaveTextContent(
      "Now: G♯ major (+1)",
    );
    fireEvent.keyDown(dial, { key: "End" });
    expect(engine.setSemitones).toHaveBeenLastCalledWith(12);
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to original key" }),
    );
    expect(engine.setSemitones).toHaveBeenLastCalledWith(0);
  });

  it("page-wide shortcuts: ←/→ step, 0 resets, Space plays/pauses", async () => {
    setup();
    await ready();
    engine.setSemitones.mockClear();
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(engine.setSemitones.mock.calls).toEqual([[1], [2], [1]]);
    fireEvent.keyDown(document.body, { key: "0" });
    expect(engine.setSemitones).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(document.body, { key: " " });
    expect(engine.play).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: " " });
    expect(engine.pause).toHaveBeenCalled();
  });

  it("a dial move before the audio is ready is applied once it is", async () => {
    const load = deferred<undefined>();
    engine.load.mockImplementation(() => load.promise);
    setup();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Transpose" }), {
      key: "ArrowLeft",
    });
    expect(engine.setSemitones).not.toHaveBeenCalled();
    await act(async () => {
      load.resolve(undefined);
      await load.promise;
    });
    await ready();
    expect(engine.setSemitones).toHaveBeenLastCalledWith(-1);
  });

  it("auto-correct tuning applies setCents(-tuning_cents), and 0 when off", async () => {
    setup();
    await ready();
    const toggle = screen.getByRole("switch", { name: "Auto-correct tuning" });
    fireEvent.click(toggle);
    expect(engine.setCents).toHaveBeenLastCalledWith(12);
    fireEvent.click(toggle);
    expect(engine.setCents).toHaveBeenLastCalledWith(0);
  });

  it("the player is usable before the key arrives, then fills it in", async () => {
    const { rerender } = setup(PENDING);
    await ready();
    expect(screen.getByText("Analyzing key…")).toBeInTheDocument();
    rerender(
      <TrackWorkspace
        track={TRACK}
        keyState={READY}
        onStartOver={onStartOver}
      />,
    );
    expect(screen.getByText("Original:").closest("p")).toHaveTextContent(
      "G major (82%)",
    );
  });

  it("switching to an alternate key changes the displayed basis", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /E minor/ }));
    expect(screen.getByText("Original:").closest("p")).toHaveTextContent(
      "E minor (71%)",
    );
  });

  it("exports the shifted, tuning-corrected render with a descriptive name", async () => {
    setup();
    await ready();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Transpose" }), {
      key: "ArrowRight",
    });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Transpose" }), {
      key: "ArrowRight",
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Auto-correct tuning" }),
    );
    expect(screen.getByText("G major → A major (+2)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    await waitFor(() => {
      expect(downloadBlob).toHaveBeenCalledWith(
        expect.any(Blob),
        "My Song (A major, +2).wav",
      );
    });
    expect(engine.renderOffline).toHaveBeenCalledWith(
      expect.objectContaining({ semitones: 2, cents: 12 }),
    );
  });

  it("works without a key or a title", async () => {
    setup({ status: "failed", info: null }, { ...TRACK, title: null });
    await ready();
    expect(
      screen.getByRole("heading", { name: "Untitled" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Key unknown")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Transpose" })).toHaveAttribute(
      "aria-valuetext",
      "Original key",
    );
    fireEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    await waitFor(() => {
      expect(downloadBlob).toHaveBeenCalledWith(
        expect.any(Blob),
        "PitchBend Live export (0).wav",
      );
    });
  });

  it("'New song' starts over; unmounting disposes the engine", async () => {
    const { unmount } = setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New song" }));
    expect(onStartOver).toHaveBeenCalled();
    unmount();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("an engine failure is explained, and Try again reloads the track in a new engine", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failed = engine;
    failed.load.mockRejectedValueOnce(
      new EngineError("network", "Couldn't download the audio (HTTP 503)."),
    );
    setup();
    expect(
      await screen.findByText("Couldn’t download the audio"),
    ).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledTimes(1);

    const fresh = new FakeEngine();
    vi.mocked(audio.createAudioEngine).mockImplementation(() => fresh);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(failed.dispose).toHaveBeenCalled();
    expect(fresh.load).toHaveBeenCalledWith(
      "/media/abc.m4a",
      expect.any(Function),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("a blocked playback leaves Play usable, and pressing it clears the notice", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    setup();
    await ready();
    act(() => {
      engine.emit("error", new EngineError("playback", "Not allowed."));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The browser blocked playback",
    );
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(engine.play).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    consoleError.mockRestore();
  });
});
