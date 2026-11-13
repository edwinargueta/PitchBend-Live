// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { describe, expect, it } from "vitest";
import {
  isCommand,
  isKey,
  isRestoreRequest,
  isStatusMessage,
  isTabSettings,
  isTabStatus,
  preciseNow,
  type TabStatus,
} from "./protocol";

const status: TabStatus = {
  state: "active",
  settings: { semitones: 2, bypass: false, key: { tonic: "G", mode: "major" } },
  site: "youtube",
  shifterMs: 60,
  addedMs: 70,
  error: null,
  appliedAt: 1000.5,
  sentAt: 998.25,
};

describe("isKey", () => {
  it("should accept a pitch class and mode", () => {
    expect(isKey({ tonic: "A#", mode: "minor" })).toBe(true);
  });

  it.each([
    null,
    "G major",
    { tonic: "Bb", mode: "major" },
    { tonic: "G", mode: "dorian" },
    { tonic: "G" },
  ])("should reject %j", (value) => {
    expect(isKey(value)).toBe(false);
  });
});

describe("isCommand", () => {
  it.each([
    { type: "set", semitones: 2 },
    { type: "set", semitones: -40, sentAt: 12.5 },
    { type: "nudge", delta: -1 },
    { type: "reset" },
    { type: "setBypass", on: true },
    { type: "toggleBypass" },
    { type: "setKey", key: { tonic: "C", mode: "major" } },
    { type: "setKey", key: null },
    { type: "getStatus" },
  ])("should accept %j", (value) => {
    expect(isCommand(value)).toBe(true);
  });

  it.each([
    null,
    42,
    {},
    { type: "unknown" },
    { type: "set" },
    { type: "set", semitones: "2" },
    { type: "set", semitones: Number.NaN },
    { type: "set", semitones: Number.POSITIVE_INFINITY },
    { type: "nudge", delta: Number.NaN },
    { type: "setBypass", on: "yes" },
    { type: "setKey", key: { tonic: "H", mode: "major" } },
    { type: "setKey" },
    { type: "reset", sentAt: "now" },
    { type: "reset", sentAt: Number.NaN },
  ])("should reject %j", (value) => {
    expect(isCommand(value)).toBe(false);
  });
});

describe("isTabSettings", () => {
  it("should accept settings with and without a key", () => {
    expect(isTabSettings({ semitones: 0, bypass: false, key: null })).toBe(
      true,
    );
    expect(isTabSettings(status.settings)).toBe(true);
  });

  it.each([
    { semitones: 0, bypass: false },
    { semitones: Number.NaN, bypass: false, key: null },
    { semitones: 0, bypass: 1, key: null },
    { semitones: 0, bypass: false, key: "G" },
  ])("should reject %j", (value) => {
    expect(isTabSettings(value)).toBe(false);
  });
});

describe("isTabStatus / isStatusMessage", () => {
  it("should accept a full status and a status message", () => {
    expect(isTabStatus(status)).toBe(true);
    expect(isStatusMessage({ type: "status", status })).toBe(true);
  });

  it("should accept nulls in the optional fields", () => {
    expect(
      isTabStatus({
        ...status,
        state: "idle",
        site: null,
        shifterMs: null,
        addedMs: null,
        error: "x",
        appliedAt: null,
        sentAt: null,
      }),
    ).toBe(true);
  });

  it.each([
    { state: "running" },
    { settings: { semitones: 1 } },
    { site: "vimeo" },
    { shifterMs: "60" },
    { addedMs: Number.NaN },
    { error: 5 },
    { appliedAt: undefined },
    { sentAt: "x" },
  ])("should reject a status with %j", (patch) => {
    expect(isTabStatus({ ...status, ...patch })).toBe(false);
  });

  it("should reject other message types and bad payloads", () => {
    expect(isStatusMessage({ type: "status", status: {} })).toBe(false);
    expect(isStatusMessage({ type: "other", status })).toBe(false);
    expect(isStatusMessage(null)).toBe(false);
  });
});

describe("isRestoreRequest", () => {
  it("should recognise only restore requests", () => {
    expect(isRestoreRequest({ type: "restoreRequest" })).toBe(true);
    expect(isRestoreRequest({ type: "status" })).toBe(false);
    expect(isRestoreRequest(undefined)).toBe(false);
  });
});

describe("preciseNow", () => {
  it("should add the time origin to the monotonic clock", () => {
    expect(preciseNow({ timeOrigin: 1000, now: () => 2.5 })).toBe(1002.5);
  });

  it("should default to the global performance clock", () => {
    const before = performance.timeOrigin + performance.now();
    expect(preciseNow()).toBeGreaterThanOrEqual(before);
  });
});
