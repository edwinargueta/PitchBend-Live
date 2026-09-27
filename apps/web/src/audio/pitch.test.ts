import { describe, expect, it } from "vitest";
import {
  normalizeCents,
  normalizeSemitones,
  planRamp,
  RAMP_MS,
  RAMP_STEPS,
  totalShift,
} from "./pitch";

describe("normalizeSemitones", () => {
  it.each([
    [0, 0],
    [12, 12],
    [-12, -12],
    [13, 12],
    [-100, -12],
    [2.4, 2],
    [2.5, 3],
    [-2.5, -2],
    [-0.4, 0],
    [11.6, 12],
  ])("%s -> %s", (input, expected) => {
    expect(Object.is(normalizeSemitones(input), expected)).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects %s",
    (input) => {
      expect(() => normalizeSemitones(input)).toThrow(RangeError);
    },
  );
});

describe("normalizeCents", () => {
  it.each([
    [0, 0],
    [50, 50],
    [-50, -50],
    [51, 50],
    [-80, -50],
    [-12, -12],
    [12.5, 12.5],
    [-0, 0],
  ])("%s -> %s", (input, expected) => {
    expect(Object.is(normalizeCents(input), expected)).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (input) => {
    expect(() => normalizeCents(input)).toThrow(RangeError);
  });
});

describe("totalShift", () => {
  it("combines semitones and cents", () => {
    expect(totalShift(2, 0)).toBe(2);
    expect(totalShift(2, -12)).toBeCloseTo(1.88, 12);
    expect(totalShift(-12, -50)).toBe(-12.5);
  });
});

describe("planRamp", () => {
  it("uses 30–50 ms by default", () => {
    expect(RAMP_MS).toBeGreaterThanOrEqual(30);
    expect(RAMP_MS).toBeLessThanOrEqual(50);
    expect(RAMP_STEPS).toBeGreaterThan(1);
  });

  it("starts immediately and lands exactly on the target at the end", () => {
    expect(planRamp(0, 4, 40, 4)).toEqual([
      { atMs: 0, value: 1 },
      { atMs: 40 / 3, value: 2 },
      { atMs: 80 / 3, value: 3 },
      { atMs: 40, value: 4 },
    ]);
  });

  it("ramps downwards too, ending on the exact target", () => {
    const plan = planRamp(1.1, -0.3, 30, 3);
    expect(plan.map((s) => s.atMs)).toEqual([0, 15, 30]);
    expect(plan.at(-1)?.value).toBe(-0.3);
    expect(plan[0]?.value).toBeCloseTo(1.1 - 1.4 / 3, 12);
  });

  it("degenerates to a single immediate step", () => {
    expect(planRamp(0, 5, 40, 1)).toEqual([{ atMs: 0, value: 5 }]);
    expect(planRamp(0, 5, 40, 0)).toEqual([{ atMs: 0, value: 5 }]);
  });
});
