import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isTypingTarget,
  useGlobalShortcuts,
  type ShortcutHandlers,
} from "./useGlobalShortcuts";

const handlers = {
  onStep: vi.fn<ShortcutHandlers["onStep"]>(),
  onReset: vi.fn(),
  onTogglePlay: vi.fn(),
};

function Harness({ enabled = true }: { enabled?: boolean }) {
  useGlobalShortcuts(handlers, enabled);
  return (
    <div>
      <input aria-label="text" type="text" />
      <input aria-label="url" type="url" />
      <input aria-label="seek" type="range" />
      <input aria-label="check" type="checkbox" />
      <textarea aria-label="area" />
      <button type="button">btn</button>
      <div role="slider" tabIndex={0} aria-label="dial" aria-valuenow={0} />
      <div
        aria-label="editable"
        contentEditable
        suppressContentEditableWarning
      />
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGlobalShortcuts", () => {
  it("arrows step the key, 0 resets, Space toggles play", () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    fireEvent.keyDown(document.body, { key: "0" });
    fireEvent.keyDown(document.body, { key: " " });
    expect(handlers.onStep.mock.calls).toEqual([[1], [-1]]);
    expect(handlers.onReset).toHaveBeenCalledTimes(1);
    expect(handlers.onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("prevents the page from scrolling on Space and arrows", () => {
    render(<Harness />);
    const space = fireEvent.keyDown(document.body, { key: " " });
    const arrow = fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(space).toBe(false); // defaultPrevented
    expect(arrow).toBe(false);
  });

  it("never fires while typing", () => {
    render(<Harness />);
    for (const name of ["text", "url", "area"]) {
      const el = screen.getByLabelText(name);
      fireEvent.keyDown(el, { key: "ArrowLeft" });
      fireEvent.keyDown(el, { key: "0" });
      fireEvent.keyDown(el, { key: " " });
    }
    expect(handlers.onStep).not.toHaveBeenCalled();
    expect(handlers.onReset).not.toHaveBeenCalled();
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
  });

  it("leaves native Space on buttons/checkboxes and arrows on range inputs/sliders", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("button", { name: "btn" }), {
      key: " ",
    });
    fireEvent.keyDown(screen.getByLabelText("check"), { key: " " });
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("seek"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByLabelText("dial"), { key: "ArrowRight" });
    expect(handlers.onStep).not.toHaveBeenCalled();
    // …but arrows on a button still move the key, and Space on the seek bar plays.
    fireEvent.keyDown(screen.getByRole("button", { name: "btn" }), {
      key: "ArrowRight",
    });
    fireEvent.keyDown(screen.getByLabelText("seek"), { key: " " });
    expect(handlers.onStep).toHaveBeenCalledWith(1);
    expect(handlers.onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("ignores modified keys, repeats of Space, already-handled events and other keys", () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: "ArrowLeft", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "0", metaKey: true });
    fireEvent.keyDown(document.body, { key: " ", altKey: true });
    fireEvent.keyDown(document.body, { key: " ", repeat: true });
    fireEvent.keyDown(document.body, { key: "a" });
    const handled = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      cancelable: true,
      bubbles: true,
    });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(handlers.onStep).not.toHaveBeenCalled();
    expect(handlers.onReset).not.toHaveBeenCalled();
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
  });

  it("does nothing when disabled, and cleans up on unmount", () => {
    const { rerender, unmount } = render(<Harness enabled={false} />);
    fireEvent.keyDown(document.body, { key: " " });
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
    rerender(<Harness />);
    unmount();
    fireEvent.keyDown(document.body, { key: " " });
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
  });
});

describe("isTypingTarget", () => {
  it("recognises text fields and editable content only", () => {
    const text = document.createElement("input");
    const range = document.createElement("input");
    range.type = "range";
    const select = document.createElement("select");
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(range)).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});
