import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { KEY_G } from "../__tests__/fakeLib";
import { KeyReadout } from "./KeyReadout";

vi.mock(
  "../../lib/music",
  async () => (await import("../__tests__/fakeLib")).fakeMusic,
);

type Props = ComponentProps<typeof KeyReadout>;

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    keyState: { status: "ready", info: KEY_G },
    semitones: 2,
    basisIndex: 0,
    onBasisChange: vi.fn(),
    autoTune: false,
    onAutoTuneChange: vi.fn(),
    ...overrides,
  };
  render(<KeyReadout {...props} />);
  return props;
}

const line = (label: string) => screen.getByText(label).closest("p");

describe("KeyReadout", () => {
  it("shows a skeleton while the key is analyzed; the shift still reads live", () => {
    setup({ keyState: { status: "pending", info: null } });
    expect(screen.getByText("Analyzing key…")).toHaveClass("sr-only");
    expect(line("Now:")).toHaveTextContent("Now: +2");
    expect(screen.getByText("Capo hint for 2")).toBeInTheDocument();
  });

  it("shows 'Key unknown' when detection failed", () => {
    setup({ keyState: { status: "failed", info: null }, semitones: -1 });
    expect(line("Original:")).toHaveTextContent("Original: Key unknown");
    expect(
      screen.getByText(/playback and transposing still work/),
    ).toBeInTheDocument();
    expect(line("Now:")).toHaveTextContent("Now: −1");
    expect(screen.queryByText(/Tuning/)).not.toBeInTheDocument();
  });

  it("shows the original key with confidence and the live new key", () => {
    setup();
    expect(line("Original:")).toHaveTextContent("Original: G major (82%)");
    expect(line("Now:")).toHaveTextContent("Now: A major (+2)");
  });

  it("taps switch between the detected alternates", () => {
    const props = setup();
    const group = screen.getByRole("group", {
      name: "Detected key: tap to switch",
    });
    expect(group).toBeInTheDocument();
    const main = screen.getByRole("button", { name: /G major/ });
    const alt = screen.getByRole("button", { name: /E minor/ });
    expect(main).toHaveAttribute("aria-pressed", "true");
    expect(alt).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(alt);
    expect(props.onBasisChange).toHaveBeenCalledWith(1);
  });

  it("an alternate becomes the basis for display", () => {
    setup({ basisIndex: 1 });
    expect(line("Original:")).toHaveTextContent("Original: E minor (71%)");
    expect(line("Now:")).toHaveTextContent("Now: F♯ minor (+2)");
    expect(screen.getByRole("button", { name: /E minor/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("falls back to the detected key for an out-of-range basis", () => {
    setup({ basisIndex: 9 });
    expect(line("Original:")).toHaveTextContent("Original: G major (82%)");
  });

  it("hides the alternates when there are none", () => {
    setup({
      keyState: { status: "ready", info: { ...KEY_G, alternates: [] } },
    });
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("shows the tuning offset with an auto-correct switch", () => {
    const props = setup();
    expect(line("Tuning:")).toHaveTextContent("Tuning: −12 cents");
    const toggle = screen.getByRole("switch", { name: "Auto-correct tuning" });
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText(/Shifts the song by \+12 cents/),
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(props.onAutoTuneChange).toHaveBeenCalledWith(true);
  });

  it("reflects the switch state", () => {
    const props = setup({ autoTune: true });
    const toggle = screen.getByRole("switch", { name: "Auto-correct tuning" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(props.onAutoTuneChange).toHaveBeenCalledWith(false);
  });

  it("no switch when the song is already in tune", () => {
    setup({
      keyState: { status: "ready", info: { ...KEY_G, tuning_cents: 0 } },
      semitones: 0,
    });
    expect(line("Tuning:")).toHaveTextContent("Tuning: 0 cents");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText(/Capo hint/)).not.toBeInTheDocument();
  });
});
