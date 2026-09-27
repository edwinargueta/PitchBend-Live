import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { EngineError } from "../../audio/errors";
import { fakeBuffer } from "../__tests__/fakeEngine";
import { Player } from "./Player";

vi.mock("./Waveform", () => ({
  Waveform: ({ currentTime }: { currentTime: number }) => (
    <div data-testid="waveform-stub">{currentTime}</div>
  ),
}));

type Props = ComponentProps<typeof Player>;

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    title: "My Song",
    status: "ready",
    loadPct: 100,
    isPlaying: false,
    currentTime: 65,
    duration: 185,
    audioBuffer: fakeBuffer(185),
    error: null,
    onToggle: vi.fn(),
    onSeek: vi.fn(),
    onRetry: vi.fn(),
    onStartOver: vi.fn(),
    ...overrides,
  };
  render(<Player {...props} />);
  return props;
}

describe("Player", () => {
  it("shows the title as a heading, time and duration", () => {
    setup();
    expect(
      screen.getByRole("heading", { name: "My Song" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1:05")).toBeInTheDocument();
    expect(screen.getByText("3:05")).toBeInTheDocument();
    expect(screen.getByTestId("waveform-stub")).toHaveTextContent("65");
  });

  it("renders an untrusted title as text, never HTML", () => {
    setup({ title: '<img src=x onerror="alert(1)">' });
    expect(document.querySelector("img")).toBeNull();
    expect(
      screen.getByRole("heading", { name: '<img src=x onerror="alert(1)">' }),
    ).toBeInTheDocument();
  });

  it("play/pause toggles with a changing label", () => {
    const props = setup();
    const play = screen.getByRole("button", { name: "Play" });
    expect(play).toHaveAttribute("aria-keyshortcuts", "Space");
    fireEvent.click(play);
    expect(props.onToggle).toHaveBeenCalled();
  });

  it("labels the button Pause while playing", () => {
    setup({ isPlaying: true });
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("the seek bar is labelled, spoken and seeks", () => {
    const props = setup();
    const seek = screen.getByRole("slider", { name: "Seek" });
    expect(seek).toHaveAttribute(
      "aria-valuetext",
      "1 minute 5 seconds of 3 minutes 5 seconds",
    );
    expect(seek).toHaveAttribute("max", "185");
    fireEvent.change(seek, { target: { value: "100" } });
    expect(props.onSeek).toHaveBeenCalledWith(100);
  });

  it("clamps the displayed time to the duration", () => {
    setup({ currentTime: 999, duration: 100 });
    expect(screen.getAllByText("1:40")).toHaveLength(2);
  });

  it("while loading: progress, disabled controls and a placeholder waveform", () => {
    setup({ status: "loading", loadPct: 30, audioBuffer: null, duration: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("Loading audio…");
    expect(
      screen.getByRole("progressbar", { name: "Loading audio" }),
    ).toHaveAttribute("aria-valuenow", "30");
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeDisabled();
    expect(screen.queryByTestId("waveform-stub")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("an unplayable browser gets cause-specific copy and no retry", () => {
    const props = setup({
      status: "error",
      audioBuffer: null,
      error: new EngineError("decode", "This browser can't decode AAC audio.", {
        hint: "no-aac",
      }),
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "This browser can’t play PitchBend Live audio",
    );
    expect(alert).toHaveTextContent("It can’t decode AAC audio");
    expect(alert).toHaveTextContent(
      "Open this page in Chrome, Safari or Firefox.",
    );
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(props.onStartOver).toHaveBeenCalled();
  });

  it("shows the raw message under a collapsed Technical details, as text only", () => {
    setup({
      status: "error",
      error: new EngineError("network", '<b onclick="x()">HTTP 503</b>', {
        cause: new TypeError("Failed to fetch"),
      }),
    });
    const summary = screen.getByText("Technical details");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    const pre = details?.querySelector("pre");
    expect(pre?.textContent).toContain('Error: <b onclick="x()">HTTP 503</b>');
    expect(pre?.textContent).toContain("Cause: TypeError: Failed to fetch");
    expect(document.querySelector("b")).toBeNull();
    // The details aren't part of what screen readers announce.
    expect(screen.getByRole("alert")).not.toHaveTextContent("HTTP 503");
  });

  it("retryable failures offer Try again alongside Start over", () => {
    const props = setup({
      status: "error",
      error: new EngineError("processor", "The worklet crashed."),
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The audio processor stopped",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Start over" })).toBeEnabled();
  });

  it("a blocked playback is explained without disabling the player", () => {
    const props = setup({
      status: "ready",
      error: new EngineError("playback", "Not allowed."),
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The browser blocked playback",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Press Play again");
    const play = screen.getByRole("button", { name: "Play" });
    expect(play).toBeEnabled();
    fireEvent.click(play);
    expect(props.onToggle).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("an error status without details still explains and offers a retry", () => {
    setup({ status: "error", error: null });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn’t play this audio",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});
