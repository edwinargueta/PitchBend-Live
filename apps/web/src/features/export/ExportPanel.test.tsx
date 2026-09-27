import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as audio from "../../audio";
import { deferred, fakeBuffer, FakeEngine } from "../__tests__/fakeEngine";
import { downloadBlob } from "./download";
import { ExportPanel } from "./ExportPanel";

vi.mock("../../audio", () => ({
  createAudioEngine: vi.fn(),
  encodeWav: vi.fn(),
}));
vi.mock("./download", () => ({ downloadBlob: vi.fn() }));

const encodeWav = vi.mocked(audio.encodeWav);
const download = vi.mocked(downloadBlob);
const WAV = new Blob(["RIFF"], { type: "audio/wav" });
let engine: FakeEngine;

type Props = ComponentProps<typeof ExportPanel>;

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    engine,
    title: "My Song",
    semitones: 2,
    cents: 12,
    newKeyAscii: "A major",
    summary: "G major → A major (+2)",
    ...overrides,
  };
  return render(<ExportPanel {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  engine = new FakeEngine();
  encodeWav.mockReturnValue(WAV);
});

describe("ExportPanel", () => {
  it("renders offline, encodes WAV and downloads '<title> (<key>, +2).wav'", async () => {
    setup();
    expect(screen.getByText("G major → A major (+2)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    await waitFor(() => {
      expect(download).toHaveBeenCalledWith(WAV, "My Song (A major, +2).wav");
    });
    expect(engine.renderOffline).toHaveBeenCalledWith({
      semitones: 2,
      cents: 12,
      onProgress: expect.any(Function) as () => void,
    });
    expect(encodeWav).toHaveBeenCalledWith(
      await engine.renderOffline.mock.results[0]?.value,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved “My Song (A major, +2).wav”.",
    );
  });

  it("shows render progress and blocks a second export meanwhile", async () => {
    const render$ = deferred<AudioBuffer>();
    let report: ((pct: number) => void) | undefined;
    engine.renderOffline.mockImplementation((opts) => {
      report = opts.onProgress;
      return render$.promise;
    });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    const busy = screen.getByRole("button", { name: "Rendering…" });
    expect(busy).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Rendering your WAV file…",
    );
    expect(
      screen.getByRole("progressbar", { name: "Rendering WAV" }),
    ).not.toHaveAttribute("aria-valuenow");
    act(() => {
      report?.(37);
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "37",
    );
    expect(screen.getByText("37%")).toBeInTheDocument();
    fireEvent.click(busy);
    expect(engine.renderOffline).toHaveBeenCalledTimes(1);
    await act(async () => {
      render$.resolve(fakeBuffer(1));
      await render$.promise;
    });
    await waitFor(() => {
      expect(download).toHaveBeenCalled();
    });
  });

  it("names the file without a key when the key is unknown, and sanitizes the title", async () => {
    setup({ newKeyAscii: null, semitones: -1, title: "a/b:c", summary: null });
    fireEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    await waitFor(() => {
      expect(download).toHaveBeenCalledWith(WAV, "a b c (-1).wav");
    });
  });

  it("is disabled until the audio is loaded", () => {
    setup({ engine: null });
    expect(screen.getByRole("button", { name: "Download WAV" })).toBeDisabled();
  });

  it("reports a failed render", async () => {
    engine.renderOffline.mockRejectedValue(new Error("out of memory"));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The export failed",
    );
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download WAV" })).toBeEnabled();
  });

  it("doesn't download after unmounting mid-render", async () => {
    const render$ = deferred<AudioBuffer>();
    let report: ((pct: number) => void) | undefined;
    engine.renderOffline.mockImplementation((opts) => {
      report = opts.onProgress;
      return render$.promise;
    });
    const { unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    unmount();
    report?.(80);
    await act(async () => {
      render$.resolve(fakeBuffer(1));
      await render$.promise;
    });
    expect(download).not.toHaveBeenCalled();
  });

  it("a failure after unmounting is silent", async () => {
    const render$ = deferred<AudioBuffer>();
    engine.renderOffline.mockImplementation(() => render$.promise);
    const { unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Download WAV" }));
    unmount();
    await act(async () => {
      render$.reject(new Error("x"));
      await render$.promise.catch(() => undefined);
    });
    expect(download).not.toHaveBeenCalled();
  });
});
