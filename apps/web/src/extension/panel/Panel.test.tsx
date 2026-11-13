// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TabStatus } from "../shared/protocol";
import { NO_RECEIVER_COPY, NOT_YOUTUBE_COPY, Panel, PanelApp } from "./Panel";
import { PanelStore, type PanelView } from "./panelStore";
import { fakePanelChrome } from "../testing/fakeChrome";

const G = { tonic: "G", mode: "major" } as const;

function ready(patch: Partial<TabStatus> = {}): PanelView {
  return {
    kind: "ready",
    tabId: 4,
    status: {
      state: "active",
      settings: { semitones: 2, bypass: false, key: G },
      site: "youtube",
      shifterMs: 60,
      addedMs: 70,
      error: null,
      appliedAt: null,
      sentAt: null,
      ...patch,
    },
  };
}

function renderPanel(view: PanelView) {
  const send = vi.fn();
  render(<Panel view={view} send={send} />);
  return send;
}

describe("Panel views", () => {
  it.each<[PanelView, RegExp]>([
    [{ kind: "loading" }, /Connecting/],
    [{ kind: "not-youtube" }, new RegExp(NOT_YOUTUBE_COPY)],
    [{ kind: "no-receiver", tabId: 1 }, new RegExp(NO_RECEIVER_COPY)],
  ])("%j shows its message and no dial", (view, text) => {
    renderPanel(view);
    expect(screen.getByRole("status")).toHaveTextContent(text);
    expect(screen.queryByRole("slider")).toBeNull();
  });
});

describe("Panel controls", () => {
  it("should show the readout, capo, delay and status (AC-10, AC-3)", () => {
    renderPanel(ready());
    expect(screen.getByText("G major → A major (+2)")).toBeInTheDocument();
    expect(screen.getByText("Capo 2")).toBeInTheDocument();
    expect(
      screen.getByText("Audio delay behind the video: 70 ms"),
    ).toBeInTheDocument();
    expect(screen.getByText("Transposing this tab.")).toBeInTheDocument();
  });

  it("should expose the dial as a slider with spoken text (AC-11)", () => {
    renderPanel(ready());
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuenow", "2");
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Plus 2 semitones, A major",
    );
  });

  it("should send set commands from the dial's keys (AC-11)", () => {
    const send = renderPanel(ready());
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "0" });
    expect(send.mock.calls).toEqual([
      [{ type: "set", semitones: 3 }],
      [{ type: "set", semitones: 1 }],
      [{ type: "set", semitones: 0 }],
    ]);
  });

  it("should toggle bypass and reflect aria-pressed (AC-7)", () => {
    const send = renderPanel(ready());
    const bypass = screen.getByRole("button", { name: "Bypass" });
    expect(bypass).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(bypass);
    expect(send).toHaveBeenCalledWith({ type: "setBypass", on: true });
  });

  it("should show a pressed bypass when bypassed", () => {
    const send = renderPanel(
      ready({ settings: { semitones: 2, bypass: true, key: null } }),
    );
    const bypass = screen.getByRole("button", { pressed: true });
    expect(bypass).toHaveTextContent(/playing the original/);
    fireEvent.click(bypass);
    expect(send).toHaveBeenCalledWith({ type: "setBypass", on: false });
  });

  it("should hide capo and delay when there are none", () => {
    renderPanel(
      ready({
        settings: { semitones: -2, bypass: false, key: null },
        addedMs: null,
      }),
    );
    expect(screen.queryByText(/Capo/)).toBeNull();
    expect(screen.queryByText(/Audio delay/)).toBeNull();
    expect(screen.getByText("Now:").parentElement).toHaveTextContent("Now: −2");
  });
});

describe("KeyPicker (FR-5)", () => {
  it("should send the chosen key and clear it", () => {
    const send = renderPanel(
      ready({ settings: { semitones: 2, bypass: false, key: null } }),
    );
    const [tonic, mode] = screen.getAllByRole("combobox");
    if (!tonic || !mode) throw new Error("selects missing");
    fireEvent.change(mode, { target: { value: "minor" } });
    expect(send).not.toHaveBeenCalled(); // no tonic yet
    fireEvent.change(tonic, { target: { value: "A#" } });
    expect(send).toHaveBeenLastCalledWith({
      type: "setKey",
      key: { tonic: "A#", mode: "minor" },
    });
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("should change the mode of a set key, clear it and ignore bad values", () => {
    const send = renderPanel(ready());
    const [tonic, mode] = screen.getAllByRole("combobox");
    if (!tonic || !mode) throw new Error("selects missing");
    expect(tonic).toHaveDisplayValue("G");
    fireEvent.change(mode, { target: { value: "minor" } });
    expect(send).toHaveBeenLastCalledWith({
      type: "setKey",
      key: { tonic: "G", mode: "minor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(send).toHaveBeenLastCalledWith({ type: "setKey", key: null });
    fireEvent.change(tonic, { target: { value: "" } });
    expect(send).toHaveBeenLastCalledWith({ type: "setKey", key: null });
    send.mockClear();
    mode.append(new Option("lydian", "lydian"));
    fireEvent.change(mode, { target: { value: "lydian" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("should spell tonics for the mode", () => {
    renderPanel(ready());
    expect(screen.getByRole("option", { name: "B♭" })).toBeInTheDocument();
  });
});

describe("PanelApp", () => {
  it("should render the store's view and send through it", async () => {
    const fake = fakePanelChrome({
      id: 4,
      url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    });
    const view = ready();
    if (view.kind !== "ready") throw new Error("unreachable");
    fake.sendMessage.mockResolvedValue(view.status);
    const store = new PanelStore(fake.chrome, null, () => 1);
    render(<PanelApp store={store} />);
    const slider = await screen.findByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(fake.sendMessage).toHaveBeenLastCalledWith(4, {
      type: "set",
      semitones: 3,
      sentAt: 1,
    });
  });
});
