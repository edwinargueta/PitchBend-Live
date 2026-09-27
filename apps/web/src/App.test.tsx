import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type WaveSurfer from "wavesurfer.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as audio from "./audio";
import { FakeEngine } from "./features/__tests__/fakeEngine";
import {
  AUDIO_READY,
  JOB_DONE,
  JOB_QUEUED,
  KEY_G,
  makeTrack,
  type makeFakeSse,
} from "./features/__tests__/fakeLib";
import { loadAudioModule } from "./hooks/audioModule";
import * as api from "./lib/api";
import * as sse from "./lib/sse";

vi.mock("./lib/api", async () =>
  (await import("./features/__tests__/fakeLib")).makeFakeApi(),
);
vi.mock("./lib/sse", async () =>
  (await import("./features/__tests__/fakeLib")).makeFakeSse(),
);
vi.mock(
  "./lib/errors",
  async () => (await import("./features/__tests__/fakeLib")).fakeErrors,
);
vi.mock(
  "./lib/youtube",
  async () => (await import("./features/__tests__/fakeLib")).fakeYoutube,
);
vi.mock(
  "./lib/music",
  async () => (await import("./features/__tests__/fakeLib")).fakeMusic,
);
vi.mock("./audio", () => ({ createAudioEngine: vi.fn(), encodeWav: vi.fn() }));
vi.mock("./hooks/audioModule", async (importOriginal) => {
  const real = await importOriginal<typeof import("./hooks/audioModule")>();
  return { loadAudioModule: vi.fn(real.loadAudioModule) };
});
const { createWaveSurfer } = vi.hoisted(() => ({
  createWaveSurfer: vi.fn<() => WaveSurfer>(),
}));
vi.mock("wavesurfer.js", () => ({ default: { create: createWaveSurfer } }));

const VALID = "https://youtu.be/dQw4w9WgXcQ";
const fakeSse = sse as unknown as ReturnType<typeof makeFakeSse>;
let engine: FakeEngine;

function paste(text: string) {
  const input = screen.getByLabelText("YouTube link");
  fireEvent(
    input,
    createEvent.paste(input, { clipboardData: { getData: () => text } }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeSse.subscriptions.length = 0;
  engine = new FakeEngine();
  vi.mocked(audio.createAudioEngine).mockImplementation(() => engine);
  createWaveSurfer.mockImplementation(
    () =>
      ({
        on: vi.fn(),
        setTime: vi.fn(),
        setMuted: vi.fn(),
        setOptions: vi.fn(),
        destroy: vi.fn(),
      }) as unknown as WaveSurfer,
  );
});

describe("App", () => {
  it("renders the input screen", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "KeyShift" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("YouTube link")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose audio file" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/deleted after 24 hours/)).toBeInTheDocument();
    // Nothing heavy until a track is chosen.
    expect(loadAudioModule).not.toHaveBeenCalled();
    expect(audio.createAudioEngine).not.toHaveBeenCalled();
  });

  it("prefetches the audio engine once a song is chosen", async () => {
    vi.mocked(api.createJob).mockResolvedValue(JOB_QUEUED);
    render(<App />);
    paste(VALID);
    await waitFor(() => {
      expect(loadAudioModule).toHaveBeenCalled();
    });
    expect(audio.createAudioEngine).not.toHaveBeenCalled(); // created only on audio_ready
  });

  it("validates the URL inline without calling the server", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("YouTube link"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "doesn't look like a YouTube",
    );
    expect(api.createJob).not.toHaveBeenCalled();
  });

  it("paste → named stages → player on audio_ready → key on key_ready", async () => {
    vi.mocked(api.createJob).mockResolvedValue(JOB_QUEUED);
    render(<App />);
    paste(VALID);
    expect(api.createJob).toHaveBeenCalledWith(VALID, expect.anything());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Contacting the server…",
    );

    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalled();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Waiting in line…");
    const { handlers } = fakeSse.last();
    act(() => {
      handlers.onProgress?.({ stage: "fetching", pct: 50 });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Fetching audio…");
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );

    act(() => {
      handlers.onAudioReady?.(AUDIO_READY);
    });
    expect(
      await screen.findByRole("heading", { name: "My Song" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Analyzing key…")).toBeInTheDocument();
    await waitFor(() => {
      expect(engine.load).toHaveBeenCalledWith(
        "/media/abc.m4a",
        expect.any(Function),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    });

    act(() => {
      handlers.onKeyReady?.(KEY_G);
      handlers.onDone?.();
    });
    expect(screen.getByText("Original:").closest("p")).toHaveTextContent(
      "G major (82%)",
    );
  });

  it("KEY_DETECTION_FAILED shows 'Key unknown' and playback keeps working", async () => {
    vi.mocked(api.createJob).mockResolvedValue(JOB_QUEUED);
    render(<App />);
    paste(VALID);
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalled();
    });
    const { handlers } = fakeSse.last();
    act(() => {
      handlers.onAudioReady?.(AUDIO_READY);
      handlers.onError?.({ code: "KEY_DETECTION_FAILED", message: "x" });
      handlers.onDone?.();
    });
    expect(await screen.findByText("Key unknown")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(engine.play).toHaveBeenCalled();
  });

  it("a cache hit reads the track and goes straight to the player", async () => {
    vi.mocked(api.createJob).mockResolvedValue(JOB_DONE);
    vi.mocked(api.getTrack).mockResolvedValue(makeTrack());
    render(<App />);
    paste(VALID);
    expect(
      await screen.findByRole("heading", { name: "My Song" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Original:").closest("p")).toHaveTextContent(
      "G major (82%)",
    );
    expect(fakeSse.subscribeToJob).not.toHaveBeenCalled();
  });

  it("an upload shows progress", () => {
    let report: ((pct: number) => void) | undefined;
    vi.mocked(api.uploadFile).mockImplementation((_file, opts) => {
      report = opts?.onProgress;
      return new Promise(() => undefined);
    });
    render(<App />);
    const file = new File(["abc"], "song.mp3", { type: "audio/mpeg" });
    fireEvent.change(screen.getByLabelText("Audio file"), {
      target: { files: [file] },
    });
    expect(api.uploadFile).toHaveBeenCalledWith(file, expect.anything());
    act(() => {
      report?.(25);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Uploading…");
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
  });

  it("SOURCE_BLOCKED suggests uploading and opens the file picker", async () => {
    vi.mocked(api.createJob).mockRejectedValue(
      new api.ApiError("SOURCE_BLOCKED", "blocked", 502),
    );
    render(<App />);
    paste(VALID);
    expect(
      await screen.findByRole("heading", { name: "Title SOURCE_BLOCKED" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Upload the audio file instead"),
    ).toBeInTheDocument();
    const picker = screen.getByLabelText<HTMLInputElement>("Audio file");
    const click = vi.spyOn(picker, "click");
    fireEvent.click(
      screen.getByRole("button", { name: "Upload the file instead" }),
    );
    expect(click).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Choose audio file" }),
    ).toHaveFocus();
  });

  it("RATE_LIMITED shows the wait and retries the same link", async () => {
    vi.mocked(api.createJob)
      .mockRejectedValueOnce(new api.ApiError("RATE_LIMITED", "slow", 429))
      .mockResolvedValueOnce(JOB_QUEUED);
    render(<App />);
    paste(VALID);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(api.createJob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.createJob).mock.calls[1]?.[0]).toBe(VALID);
  });

  it("NOT_FOUND offers start over", async () => {
    vi.mocked(api.createJob).mockResolvedValue(JOB_DONE);
    vi.mocked(api.getTrack).mockRejectedValue(
      new api.ApiError("NOT_FOUND", "gone", 404),
    );
    render(<App />);
    paste(VALID);
    fireEvent.click(await screen.findByRole("button", { name: "Start over" }));
    expect(
      screen.queryByRole("heading", { name: "Title NOT_FOUND" }),
    ).not.toBeInTheDocument();
  });

  it("cancel stops following the job", async () => {
    vi.mocked(api.createJob).mockResolvedValue(JOB_QUEUED);
    render(<App />);
    paste(VALID);
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fakeSse.last().unsubscribe).toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("'New song' returns to the input screen and releases the engine", async () => {
    vi.mocked(api.createJob).mockResolvedValue(JOB_DONE);
    vi.mocked(api.getTrack).mockResolvedValue(makeTrack());
    render(<App />);
    paste(VALID);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "New song" }));
    expect(screen.getByLabelText("YouTube link")).toBeInTheDocument();
    expect(engine.dispose).toHaveBeenCalled();
  });
});
