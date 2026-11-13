// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { describe, expect, it } from "vitest";
import type { TabSettings } from "./protocol";
import {
  applyCommand,
  DEFAULT_SETTINGS,
  onVideoChanged,
  parseSettings,
  wantsShift,
} from "./tabState";

const G_MAJOR = { tonic: "G", mode: "major" } as const;
const at = (semitones: number, extra: Partial<TabSettings> = {}) => ({
  ...DEFAULT_SETTINGS,
  semitones,
  ...extra,
});

describe("applyCommand", () => {
  it.each([
    [2, 2],
    [13, 12],
    [-20, -12],
    [2.6, 3],
    [-0.4, 0],
  ])("set %d should give %d (AC-5)", (requested, expected) => {
    expect(
      applyCommand(DEFAULT_SETTINGS, { type: "set", semitones: requested })
        .semitones,
    ).toBe(expected);
  });

  it("nudge should step and stay clamped at the ends (AC-5)", () => {
    expect(applyCommand(at(2), { type: "nudge", delta: 1 }).semitones).toBe(3);
    expect(applyCommand(at(12), { type: "nudge", delta: 1 }).semitones).toBe(
      12,
    );
    expect(applyCommand(at(-12), { type: "nudge", delta: -1 }).semitones).toBe(
      -12,
    );
  });

  it("reset should return to 0 and keep the key and bypass", () => {
    const next = applyCommand(at(5, { key: G_MAJOR, bypass: true }), {
      type: "reset",
    });
    expect(next).toEqual({ semitones: 0, bypass: true, key: G_MAJOR });
  });

  it("should set and toggle bypass", () => {
    expect(applyCommand(at(2), { type: "setBypass", on: true }).bypass).toBe(
      true,
    );
    expect(
      applyCommand(at(2, { bypass: true }), { type: "toggleBypass" }).bypass,
    ).toBe(false);
    expect(applyCommand(at(2), { type: "toggleBypass" }).bypass).toBe(true);
  });

  it("should set and clear the original key", () => {
    const withKey = applyCommand(at(2), { type: "setKey", key: G_MAJOR });
    expect(withKey.key).toEqual(G_MAJOR);
    expect(applyCommand(withKey, { type: "setKey", key: null }).key).toBe(null);
  });

  it("getStatus should leave the settings untouched", () => {
    const settings = at(4, { key: G_MAJOR });
    expect(applyCommand(settings, { type: "getStatus" })).toBe(settings);
  });
});

describe("onVideoChanged (AC-8)", () => {
  it("should keep the transpose and bypass and clear the key", () => {
    expect(onVideoChanged(at(2, { key: G_MAJOR, bypass: true }))).toEqual({
      semitones: 2,
      bypass: true,
      key: null,
    });
  });

  it("should return the same object when there is no key", () => {
    const settings = at(2);
    expect(onVideoChanged(settings)).toBe(settings);
  });
});

describe("parseSettings", () => {
  it("should keep valid settings and normalise the semitones", () => {
    expect(parseSettings({ semitones: 3, bypass: true, key: G_MAJOR })).toEqual(
      { semitones: 3, bypass: true, key: G_MAJOR },
    );
    expect(parseSettings({ semitones: 30, bypass: false, key: null })).toEqual(
      at(12),
    );
  });

  it.each([undefined, null, "x", { semitones: "2" }])(
    "should fall back to the defaults for %j",
    (value) => {
      expect(parseSettings(value)).toBe(DEFAULT_SETTINGS);
    },
  );
});

describe("wantsShift", () => {
  it("should want the shifter only away from 0", () => {
    expect(wantsShift(at(0))).toBe(false);
    expect(wantsShift(at(-1))).toBe(true);
  });
});
