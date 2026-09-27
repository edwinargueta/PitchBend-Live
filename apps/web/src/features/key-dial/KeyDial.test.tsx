import { fireEvent, render, screen } from "@testing-library/react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { KeyDial } from "./KeyDial";

vi.mock(
  "../../lib/music",
  async () => (await import("../__tests__/fakeLib")).fakeMusic,
);

const onChange = vi.fn();

function setup(value = 2, caption: string | null = "A major") {
  const view = render(
    <KeyDial
      value={value}
      onChange={onChange}
      valueText="Plus 2 semitones, A major"
      caption={caption}
    />,
  );
  const slider = screen.getByRole("slider", { name: "Transpose" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 200,
    right: 200,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return { ...view, slider };
}

// jsdom has no pointer capture.
const proto = Element.prototype as unknown as Record<string, unknown>;
beforeAll(() => {
  proto.setPointerCapture = vi.fn();
  proto.releasePointerCapture = vi.fn();
  proto.hasPointerCapture = vi.fn(() => true);
});
afterAll(() => {
  delete proto.setPointerCapture;
  delete proto.releasePointerCapture;
  delete proto.hasPointerCapture;
});
beforeEach(() => {
  onChange.mockClear();
});

describe("KeyDial", () => {
  it("is an accessible slider from −12 to +12", () => {
    const { slider } = setup();
    expect(slider).toHaveAttribute("aria-valuemin", "-12");
    expect(slider).toHaveAttribute("aria-valuemax", "12");
    expect(slider).toHaveAttribute("aria-valuenow", "2");
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Plus 2 semitones, A major",
    );
    expect(slider).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("A major")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it.each([
    ["ArrowRight", 3],
    ["ArrowUp", 3],
    ["ArrowLeft", 1],
    ["ArrowDown", 1],
    ["PageUp", 7],
    ["PageDown", -3],
    ["Home", -12],
    ["End", 12],
    ["0", 0],
  ])("keyboard %s → %i", (key, expected) => {
    const { slider } = setup(2);
    const notCancelled = fireEvent.keyDown(slider, { key });
    expect(onChange).toHaveBeenCalledWith(expected);
    expect(notCancelled).toBe(false); // handled here, not by page shortcuts
  });

  it("clamps at the ends and ignores other or modified keys", () => {
    const { slider } = setup(12);
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "End" });
    fireEvent.keyDown(slider, { key: "ArrowLeft", ctrlKey: true });
    fireEvent.keyDown(slider, { key: "x" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("dragging round the ring snaps to semitones", () => {
    const { slider } = setup(0);
    fireEvent.pointerDown(slider, {
      clientX: 200,
      clientY: 100,
      pointerId: 1,
      button: 0,
    });
    expect(onChange).toHaveBeenLastCalledWith(8); // 3 o'clock
    expect(slider).toHaveFocus();
    expect(proto.setPointerCapture).toHaveBeenCalled();
    fireEvent.pointerMove(slider, { clientX: 0, clientY: 100, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(-8); // 9 o'clock
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(proto.releasePointerCapture).toHaveBeenCalled();
    onChange.mockClear();
    fireEvent.pointerMove(slider, { clientX: 200, clientY: 100, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores presses in the centre, non-primary buttons, and jumps across the bottom gap", () => {
    const { slider } = setup(12);
    fireEvent.pointerDown(slider, {
      clientX: 100,
      clientY: 105,
      pointerId: 1,
      button: 0,
    });
    fireEvent.pointerDown(slider, {
      clientX: 200,
      clientY: 100,
      pointerId: 1,
      button: 2,
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(slider, {
      clientX: 101,
      clientY: 199,
      pointerId: 1,
      button: 0,
    });
    expect(onChange).not.toHaveBeenCalled(); // bottom-right = +12 = current
    fireEvent.pointerMove(slider, { clientX: 99, clientY: 199, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled(); // would jump to −12
    fireEvent.pointerMove(slider, { clientX: 100, clientY: 105, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled(); // dead zone
    fireEvent.pointerCancel(slider, { pointerId: 1 });
  });

  it("the centre button resets to the original key", () => {
    setup(-3);
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to original key" }),
    );
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it("the reset button is disabled at the original key", () => {
    setup(0, null);
    expect(
      screen.getByRole("button", { name: "Reset to original key" }),
    ).toBeDisabled();
    expect(screen.getByText("Original")).toBeInTheDocument();
  });

  it("stepper buttons move by one and stop at the ends", () => {
    const { unmount } = setup(0);
    fireEvent.click(screen.getByRole("button", { name: "Up one semitone" }));
    fireEvent.click(screen.getByRole("button", { name: "Down one semitone" }));
    expect(onChange.mock.calls).toEqual([[1], [-1]]);
    unmount();
    setup(-12);
    expect(
      screen.getByRole("button", { name: "Down one semitone" }),
    ).toBeDisabled();
  });
});
