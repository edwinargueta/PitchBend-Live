// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { describe, expect, it } from "vitest";
import type { AttachState, TabSettings, TabStatus } from "../shared/protocol";
import {
  capoLine,
  delayLine,
  dialCaption,
  dialText,
  nowLine,
  SHORTCUT_HELP,
  statusCopy,
} from "./readout";

const G = { tonic: "G", mode: "major" } as const;
const s = (semitones: number, key: TabSettings["key"] = null): TabSettings => ({
  semitones,
  bypass: false,
  key,
});
const status = (patch: Partial<TabStatus> = {}): TabStatus => ({
  state: "active",
  settings: s(2),
  site: "youtube",
  shifterMs: 60,
  addedMs: 70,
  error: null,
  appliedAt: null,
  sentAt: null,
  ...patch,
});

describe("nowLine (AC-10)", () => {
  it("should name both keys with a key set", () => {
    expect(nowLine(s(2, G))).toBe("G major → A major (+2)");
  });

  it("should show only the shift without a key", () => {
    expect(nowLine(s(2))).toBe("+2");
    expect(nowLine(s(-3))).toBe("−3");
    expect(nowLine(s(0))).toBe("Original key");
  });
});

describe("capoLine", () => {
  it("should give a capo for upward shifts within reach", () => {
    expect(capoLine(s(2, G))).toBe("Capo 2");
    expect(capoLine(s(-2))).toBeNull();
    expect(capoLine(s(12))).toBeNull();
  });
});

describe("dialText / dialCaption (AC-11)", () => {
  it("should speak the shift and the key you hear", () => {
    expect(dialText(s(2, G))).toBe("Plus 2 semitones, A major");
    expect(dialText(s(3, G))).toBe("Plus 3 semitones, B flat major");
    expect(dialCaption(s(3, G))).toBe("B♭ major");
  });

  it("should speak only the shift without a key", () => {
    expect(dialText(s(2))).toBe("Plus 2 semitones");
    expect(dialText(s(0))).toBe("Original key");
    expect(dialCaption(s(2))).toBeNull();
  });
});

describe("statusCopy", () => {
  it.each<[AttachState, RegExp]>([
    ["idle", /Move the dial/],
    ["no-video", /No video found/],
    ["waiting-gesture", /Click the video once/],
    ["starting", /Starting/],
    ["active", /Transposing this tab/],
    ["error", /couldn't start/],
  ])("%s", (state, text) => {
    expect(statusCopy(status({ state })).text).toMatch(text);
  });

  it("should show the content script's reason for an error", () => {
    expect(
      statusCopy(
        status({ state: "error", error: "Taken by another extension" }),
      ),
    ).toEqual({ tone: "error", text: "Taken by another extension" });
  });
});

describe("delayLine (AC-3)", () => {
  it("should show the added delay once attached", () => {
    expect(delayLine(status())).toBe("Audio delay behind the video: 70 ms");
    expect(delayLine(status({ addedMs: null }))).toBeNull();
  });
});

describe("SHORTCUT_HELP", () => {
  it("should list the four commands", () => {
    expect(SHORTCUT_HELP).toHaveLength(4);
  });
});
