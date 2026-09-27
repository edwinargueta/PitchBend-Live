import { describe, expect, it } from "vitest";
import {
  asciiSemitones,
  exportFilename,
  sanitizeFilename,
} from "./export/filename";
import {
  arcPath,
  clampSemitones,
  dialValueText,
  pointToValue,
  polar,
  spokenShift,
  valueToAngle,
} from "./key-dial/dial";
import { formatCents } from "./key-readout/cents";
import { computePeaks } from "./player/peaks";
import { formatTime, spokenTime } from "./player/time";
import { describeProgress } from "./progress/describeProgress";

describe("formatTime / spokenTime", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(7.9)).toBe("0:07");
    expect(formatTime(187)).toBe("3:07");
    expect(formatTime(3723)).toBe("1:02:03");
    expect(formatTime(Number.NaN)).toBe("0:00");
    expect(formatTime(-5)).toBe("0:00");
  });

  it("speaks times for screen readers", () => {
    expect(spokenTime(1)).toBe("1 second");
    expect(spokenTime(0)).toBe("0 seconds");
    expect(spokenTime(60)).toBe("1 minute");
    expect(spokenTime(125)).toBe("2 minutes 5 seconds");
    expect(spokenTime(Infinity)).toBe("0 seconds");
  });
});

describe("computePeaks", () => {
  const source = (channels: number[][]) => ({
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    getChannelData: (c: number) => Float32Array.from(channels[c] ?? []),
  });

  it("takes the max |sample| per bucket across channels", () => {
    const peaks = computePeaks(
      source([
        [0.1, -0.5, 0.2, 0.3],
        [0.0, 0.1, -0.9, 0.1],
      ]),
      2,
    );
    expect(Array.from(peaks).map((p) => Number(p.toFixed(2)))).toEqual([
      0.5, 0.9,
    ]);
  });

  it("never returns more buckets than samples, and clamps to 1", () => {
    expect(computePeaks(source([[2, -3]]), 10)).toEqual(
      Float32Array.from([1, 1]),
    );
    expect(computePeaks(source([[]]), 10)).toHaveLength(0);
    expect(computePeaks(source([[0.5]]), 0)).toHaveLength(0);
  });
});

describe("export filename", () => {
  it("builds '<title> (<new key>, +2).wav'", () => {
    expect(exportFilename("My Song", 2, "A major")).toBe(
      "My Song (A major, +2).wav",
    );
    expect(exportFilename("My Song", -3, "Bb minor")).toBe(
      "My Song (Bb minor, -3).wav",
    );
    expect(exportFilename("My Song", 0, null)).toBe("My Song (0).wav");
  });

  it("uses an ASCII sign", () => {
    expect(asciiSemitones(5)).toBe("+5");
    expect(asciiSemitones(-5)).toBe("-5");
    expect(asciiSemitones(0)).toBe("0");
  });

  it("strips path separators, reserved and control characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("etc passwd");
    expect(sanitizeFilename('a<b>c:d"e|f?g*h\\i')).toBe("a b c d e f g h i");
    expect(sanitizeFilename("bad\u0000\u0007name\u009f")).toBe("bad name");
    expect(sanitizeFilename("line\none")).toBe("line one");
    expect(sanitizeFilename("  lots   of\tspace  ")).toBe("lots of space");
    expect(sanitizeFilename("...hidden.")).toBe("hidden");
  });

  it("falls back for empty titles and caps the length", () => {
    expect(sanitizeFilename(null)).toBe("PitchBend Live export");
    expect(sanitizeFilename("   ")).toBe("PitchBend Live export");
    expect(sanitizeFilename("/")).toBe("PitchBend Live export");
    expect(Array.from(sanitizeFilename("é".repeat(300)))).toHaveLength(100);
  });
});

describe("dial geometry", () => {
  it("clamps and snaps to integers", () => {
    expect(clampSemitones(2.4)).toBe(2);
    expect(clampSemitones(2.6)).toBe(3);
    expect(clampSemitones(40)).toBe(12);
    expect(clampSemitones(-40)).toBe(-12);
    expect(clampSemitones(Number.NaN)).toBe(0);
  });

  it("maps values to a ±135° sweep", () => {
    expect(valueToAngle(0)).toBe(0);
    expect(valueToAngle(12)).toBe(135);
    expect(valueToAngle(-6)).toBe(-67.5);
  });

  it("maps pointer positions to snapped values", () => {
    expect(pointToValue(0, -10)).toBe(0); // straight up
    expect(pointToValue(10, 0)).toBe(8); // 3 o'clock = 90°
    expect(pointToValue(-10, 0)).toBe(-8);
    expect(pointToValue(1, 10)).toBe(12); // bottom gap clamps
    expect(pointToValue(-1, 10)).toBe(-12);
    expect(pointToValue(0, 0)).toBe(0);
  });

  it("draws arcs", () => {
    const top = polar(100, 100, 50, 0);
    expect(top.x).toBeCloseTo(100);
    expect(top.y).toBeCloseTo(50);
    expect(arcPath(100, 100, 50, -135, 135)).toMatch(
      /^M .* A 50\.00 50\.00 0 1 1 /,
    );
    expect(arcPath(100, 100, 50, 0, 90)).toContain(" 0 0 1 ");
  });

  it("speaks the value", () => {
    expect(spokenShift(0)).toBe("Original key");
    expect(spokenShift(1)).toBe("Plus 1 semitone");
    expect(spokenShift(-3)).toBe("Minus 3 semitones");
    expect(dialValueText(2, "A major")).toBe("Plus 2 semitones, A major");
    expect(dialValueText(2, null)).toBe("Plus 2 semitones");
  });
});

describe("formatCents", () => {
  it("uses a typographic minus", () => {
    expect(formatCents(-12)).toBe("−12 cents");
    expect(formatCents(7)).toBe("+7 cents");
    expect(formatCents(0)).toBe("0 cents");
  });
});

describe("describeProgress", () => {
  it("names every stage", () => {
    expect(describeProgress("submitting", "url", null, null, null).label).toBe(
      "Contacting the server…",
    );
    expect(describeProgress("submitting", "upload", 40, null, null)).toEqual({
      label: "Uploading…",
      pct: 40,
      step: "fetch",
    });
    expect(describeProgress("waiting", "url", null, "queued", 10)).toEqual({
      label: "Waiting in line…",
      pct: null,
      step: "fetch",
    });
    expect(describeProgress("waiting", "url", null, "fetching", 30).label).toBe(
      "Fetching audio…",
    );
    expect(
      describeProgress("waiting", "upload", null, "fetching", null).label,
    ).toBe("Receiving your file…");
    expect(describeProgress("waiting", "url", null, "processing", 70)).toEqual({
      label: "Processing…",
      pct: 70,
      step: "process",
    });
    expect(
      describeProgress("waiting", "url", null, "analyzing", null).label,
    ).toBe("Analyzing key…");
    expect(describeProgress("waiting", "url", null, null, null).label).toBe(
      "Loading track…",
    );
  });
});
