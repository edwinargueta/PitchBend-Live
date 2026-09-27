import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PitchRamp } from "./ramp";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PitchRamp", () => {
  it("set() jumps without applying", () => {
    const apply = vi.fn();
    const ramp = new PitchRamp(apply, 40, 4);
    ramp.set(3);
    expect(ramp.value).toBe(3);
    expect(ramp.target).toBe(3);
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies evenly spaced steps over the ramp duration", () => {
    const apply = vi.fn();
    const ramp = new PitchRamp(apply, 40, 4);
    ramp.rampTo(4);
    expect(apply.mock.calls).toEqual([[1]]);
    expect(ramp.ramping).toBe(true);
    expect(ramp.target).toBe(4);
    vi.advanceTimersByTime(12);
    expect(apply).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenLastCalledWith(2);
    vi.advanceTimersByTime(27);
    expect(apply.mock.calls).toEqual([[1], [2], [3], [4]]);
    expect(ramp.value).toBe(4);
    expect(ramp.ramping).toBe(false);
  });

  it("reads the in-progress value while ramping", () => {
    const values: number[] = [];
    const ramp = new PitchRamp(() => values.push(ramp.value), 40, 4);
    ramp.rampTo(-4);
    vi.advanceTimersByTime(40);
    expect(values).toEqual([-1, -2, -3, -4]);
  });

  it("does nothing when already at the target", () => {
    const apply = vi.fn();
    const ramp = new PitchRamp(apply);
    ramp.rampTo(0);
    expect(apply).not.toHaveBeenCalled();
    expect(ramp.ramping).toBe(false);
  });

  it("retargets from the current value", () => {
    const apply = vi.fn();
    const ramp = new PitchRamp(apply, 40, 4);
    ramp.rampTo(4);
    vi.advanceTimersByTime(13); // at 2
    ramp.rampTo(2);
    expect(apply).toHaveBeenLastCalledWith(2); // 2 + (2 - 2) / 4
    vi.advanceTimersByTime(100);
    expect(ramp.value).toBe(2);
  });

  it("finish() cancels pending steps and lands on the target", () => {
    const apply = vi.fn();
    const ramp = new PitchRamp(apply, 40, 4);
    ramp.rampTo(4);
    ramp.finish();
    expect(ramp.value).toBe(4);
    expect(ramp.ramping).toBe(false);
    vi.advanceTimersByTime(100);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("cancel() stops mid-ramp, keeping the reached value", () => {
    const apply = vi.fn();
    const ramp = new PitchRamp(apply, 40, 4);
    ramp.rampTo(4);
    ramp.cancel();
    ramp.cancel(); // idempotent
    vi.advanceTimersByTime(100);
    expect(ramp.value).toBe(1);
    expect(ramp.target).toBe(4);
  });
});
