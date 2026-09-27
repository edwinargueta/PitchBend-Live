import { describe, expect, it } from "vitest";
import {
  MAX_CAPO_FRET,
  PITCH_CLASSES,
  capoFret,
  capoHint,
  formatKey,
  formatSemitones,
  formatTransposition,
  isMode,
  isPitchClass,
  spellTonic,
  transposeKey,
  type Key,
} from "./music";
import type { Mode, PitchClass } from "./types";

const MODES: readonly Mode[] = ["major", "minor"];

// All 24 keys: [API tonic, mode, display, spoken, ascii].
const SPELLINGS: readonly [PitchClass, Mode, string, string, string][] = [
  ["C", "major", "C", "C", "C"],
  ["C#", "major", "D♭", "D flat", "Db"],
  ["D", "major", "D", "D", "D"],
  ["D#", "major", "E♭", "E flat", "Eb"],
  ["E", "major", "E", "E", "E"],
  ["F", "major", "F", "F", "F"],
  ["F#", "major", "G♭", "G flat", "Gb"],
  ["G", "major", "G", "G", "G"],
  ["G#", "major", "A♭", "A flat", "Ab"],
  ["A", "major", "A", "A", "A"],
  ["A#", "major", "B♭", "B flat", "Bb"],
  ["B", "major", "B", "B", "B"],
  ["C", "minor", "C", "C", "C"],
  ["C#", "minor", "C♯", "C sharp", "C#"],
  ["D", "minor", "D", "D", "D"],
  ["D#", "minor", "E♭", "E flat", "Eb"],
  ["E", "minor", "E", "E", "E"],
  ["F", "minor", "F", "F", "F"],
  ["F#", "minor", "F♯", "F sharp", "F#"],
  ["G", "minor", "G", "G", "G"],
  ["G#", "minor", "G♯", "G sharp", "G#"],
  ["A", "minor", "A", "A", "A"],
  ["A#", "minor", "B♭", "B flat", "Bb"],
  ["B", "minor", "B", "B", "B"],
];

/**
 * An independent derivation of the §6.8 rule from the circle of fifths: among all
 * single-accidental spellings of the tonic, pick the key signature with the fewest
 * accidentals; break ties with flats.
 */
function deriveSpelling(tonic: PitchClass, mode: Mode): string {
  const letters = [
    { letter: "F", pc: 5, fifths: -1 },
    { letter: "C", pc: 0, fifths: 0 },
    { letter: "G", pc: 7, fifths: 1 },
    { letter: "D", pc: 2, fifths: 2 },
    { letter: "A", pc: 9, fifths: 3 },
    { letter: "E", pc: 4, fifths: 4 },
    { letter: "B", pc: 11, fifths: 5 },
  ];
  const target = PITCH_CLASSES.indexOf(tonic);
  const candidates: { name: string; accidentals: number; flat: boolean }[] = [];
  for (const { letter, pc, fifths } of letters) {
    for (const [shift, sign] of [
      [-1, "♭"],
      [0, ""],
      [1, "♯"],
    ] as const) {
      if ((pc + shift + 12) % 12 !== target) continue;
      // A minor key shares the signature of its relative major, 3 fifths lower.
      const signature = fifths + 7 * shift - (mode === "minor" ? 3 : 0);
      candidates.push({
        name: letter + sign,
        accidentals: Math.abs(signature),
        flat: signature < 0,
      });
    }
  }
  candidates.sort(
    (a, b) => a.accidentals - b.accidentals || Number(b.flat) - Number(a.flat),
  );
  const best = candidates[0];
  if (!best) throw new Error(`no spelling for ${tonic}`);
  return best.name;
}

describe("PITCH_CLASSES / isPitchClass / isMode", () => {
  it("lists the 12 sharps-only names in semitone order", () => {
    expect(PITCH_CLASSES).toEqual([
      "C",
      "C#",
      "D",
      "D#",
      "E",
      "F",
      "F#",
      "G",
      "G#",
      "A",
      "A#",
      "B",
    ]);
  });

  it.each(PITCH_CLASSES)("accepts %s", (pc) => {
    expect(isPitchClass(pc)).toBe(true);
  });

  it.each(["Bb", "Db", "H", "c", "", "C##", 1, null, undefined])(
    "rejects %j",
    (value) => {
      expect(isPitchClass(value)).toBe(false);
    },
  );

  it("recognizes modes", () => {
    expect(isMode("major")).toBe(true);
    expect(isMode("minor")).toBe(true);
    expect(isMode("dorian")).toBe(false);
    expect(isMode(undefined)).toBe(false);
  });
});

describe("transposeKey", () => {
  it.each([
    ["G", "major", 2, "A"],
    ["G", "major", -2, "F"],
    ["C", "major", 1, "C#"],
    ["C", "major", -1, "B"],
    ["B", "minor", 1, "C"],
    ["A", "minor", 3, "C"],
    ["E", "minor", 12, "E"],
    ["E", "minor", -12, "E"],
    ["D", "major", 13, "D#"],
    ["D", "major", -13, "C#"],
    ["F#", "major", 24, "F#"],
    ["F#", "major", -25, "F"],
    ["A#", "minor", 0, "A#"],
    ["C", "major", 1_000_001, "F"], // 1_000_001 mod 12 = 5
  ] as const)("%s %s %i → %s", (tonic, mode, semitones, expected) => {
    expect(transposeKey(tonic, mode, semitones)).toEqual({
      tonic: expected,
      mode,
    });
  });

  it("wraps mod 12 for every key and shift in -36..36, keeping the mode", () => {
    for (const mode of MODES) {
      for (const [index, tonic] of PITCH_CLASSES.entries()) {
        for (let s = -36; s <= 36; s++) {
          // Step one semitone at a time instead of using modular arithmetic.
          let expected = index;
          for (let i = 0; i < Math.abs(s); i++) {
            expected = s > 0 ? (expected + 1) % 12 : (expected + 11) % 12;
          }
          expect(transposeKey(tonic, mode, s)).toEqual({
            tonic: PITCH_CLASSES[expected],
            mode,
          });
        }
      }
    }
  });

  it("round-trips", () => {
    for (const tonic of PITCH_CLASSES) {
      for (let s = -12; s <= 12; s++) {
        const up = transposeKey(tonic, "minor", s);
        expect(transposeKey(up.tonic, up.mode, -s).tonic).toBe(tonic);
      }
    }
  });

  it("treats -0 as 0", () => {
    expect(transposeKey("G", "major", -0)).toEqual({
      tonic: "G",
      mode: "major",
    });
  });

  it.each([0.5, -1.5, Number.NaN, Infinity, -Infinity])(
    "rejects non-integer shift %s",
    (s) => {
      expect(() => transposeKey("C", "major", s)).toThrow(RangeError);
    },
  );

  it("rejects an unknown tonic or mode", () => {
    expect(() => transposeKey("Bb" as PitchClass, "major", 1)).toThrow(
      /Unknown pitch class: Bb/,
    );
    expect(() => transposeKey("C", "lydian" as Mode, 1)).toThrow(
      /Unknown mode: lydian/,
    );
  });
});

describe("spellTonic / formatKey", () => {
  it.each(SPELLINGS)(
    "%s %s → %s / %s / %s",
    (tonic, mode, display, spoken, ascii) => {
      expect(spellTonic(tonic, mode)).toBe(display);
      expect(formatKey({ tonic, mode })).toBe(`${display} ${mode}`);
      expect(formatKey({ tonic, mode }, "display")).toBe(`${display} ${mode}`);
      expect(formatKey({ tonic, mode }, "spoken")).toBe(`${spoken} ${mode}`);
      expect(formatKey({ tonic, mode }, "ascii")).toBe(`${ascii} ${mode}`);
    },
  );

  it("covers all 24 keys exactly once", () => {
    const keys = new Set(SPELLINGS.map(([t, m]) => `${t} ${m}`));
    expect(keys.size).toBe(24);
  });

  it.each(SPELLINGS)(
    "%s %s matches the circle-of-fifths derivation",
    (tonic, mode, display) => {
      expect(deriveSpelling(tonic, mode)).toBe(display);
    },
  );

  it("spells the §6.8 flat keys (F, B♭, E♭, A♭, D♭, G♭ majors and relative minors) with flats or naturals only", () => {
    const flatMajors: PitchClass[] = ["F", "A#", "D#", "G#", "C#", "F#"];
    for (const tonic of flatMajors) {
      expect(spellTonic(tonic, "major")).not.toContain("♯");
      const relativeMinor = transposeKey(tonic, "major", -3).tonic;
      expect(spellTonic(relativeMinor, "minor")).not.toContain("♯");
    }
  });

  it("never uses ♯ in a major key or anything but naturals on white keys", () => {
    for (const tonic of PITCH_CLASSES) {
      expect(spellTonic(tonic, "major")).not.toContain("♯");
      if (!tonic.includes("#")) {
        expect(spellTonic(tonic, "major")).toBe(tonic);
        expect(spellTonic(tonic, "minor")).toBe(tonic);
      }
    }
  });

  it("keeps ascii names filename-safe", () => {
    for (const [tonic, mode] of SPELLINGS) {
      expect(formatKey({ tonic, mode }, "ascii")).toMatch(
        /^[A-G][#b]? (major|minor)$/,
      );
    }
  });

  it("rejects unknown input", () => {
    expect(() => spellTonic("Db" as PitchClass, "major")).toThrow(RangeError);
    expect(() => spellTonic("C", "ionian" as Mode)).toThrow(RangeError);
  });
});

describe("formatSemitones", () => {
  it.each([
    [0, "0"],
    [-0, "0"],
    [1, "+1"],
    [2, "+2"],
    [12, "+12"],
    [-1, "−1"],
    [-3, "−3"],
    [-12, "−12"],
  ])("%s → %s", (n, expected) => {
    expect(formatSemitones(n)).toBe(expected);
  });

  it("uses U+2212 MINUS SIGN, not a hyphen", () => {
    expect(formatSemitones(-3)).toBe("−3");
    expect(formatSemitones(-3)).not.toContain("-");
  });

  it("rejects non-integers", () => {
    expect(() => formatSemitones(1.5)).toThrow(RangeError);
    expect(() => formatSemitones(Number.NaN)).toThrow(RangeError);
  });
});

describe("formatTransposition", () => {
  const g: Key = { tonic: "G", mode: "major" };

  it.each([
    [g, 2, "G major → A major (+2)"],
    [g, -2, "G major → F major (−2)"],
    [g, -1, "G major → G♭ major (−1)"],
    [g, 0, "G major → G major (0)"],
    [g, 12, "G major → G major (+12)"],
    [{ tonic: "A", mode: "minor" }, 1, "A minor → B♭ minor (+1)"],
    [{ tonic: "E", mode: "minor" }, -1, "E minor → E♭ minor (−1)"],
    [{ tonic: "E", mode: "minor" }, 4, "E minor → G♯ minor (+4)"],
    [{ tonic: "B", mode: "major" }, 2, "B major → D♭ major (+2)"],
  ] as const)("%j %i → %s", (from, semitones, expected) => {
    expect(formatTransposition(from, semitones)).toBe(expected);
  });

  it("rejects non-integers", () => {
    expect(() => formatTransposition(g, 0.5)).toThrow(RangeError);
  });
});

describe("capoFret / capoHint", () => {
  // shift → fret (null = no practical capo position)
  const table: [number, number | null][] = [
    [0, null],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 5],
    [6, 6],
    [7, 7],
    [8, null],
    [9, null],
    [10, null],
    [11, null],
    [12, null],
    [-1, null],
    [-2, null],
    [-3, null],
    [-4, null],
    [-5, 7],
    [-6, 6],
    [-7, 5],
    [-8, 4],
    [-9, 3],
    [-10, 2],
    [-11, 1],
    [-12, null],
    [13, 1],
    [-13, null],
    [-17, 7],
    [24, null],
  ];

  it.each(table)("%i semitones → fret %s", (semitones, fret) => {
    expect(capoFret(semitones)).toBe(fret);
    expect(capoHint(semitones)).toBe(
      fret === null ? null : `Capo ${String(fret)}`,
    );
  });

  it("never suggests a fret above MAX_CAPO_FRET", () => {
    expect(MAX_CAPO_FRET).toBe(7);
    for (let s = -24; s <= 24; s++) {
      const fret = capoFret(s);
      if (fret !== null) {
        expect(fret).toBeGreaterThanOrEqual(1);
        expect(fret).toBeLessThanOrEqual(MAX_CAPO_FRET);
        // The capo lands on the same key as the shift.
        expect(transposeKey("C", "major", fret)).toEqual(
          transposeKey("C", "major", s),
        );
      }
    }
  });

  it("returns null at 0", () => {
    expect(capoHint(0)).toBeNull();
  });

  it("rejects non-integers", () => {
    expect(() => capoHint(2.5)).toThrow(RangeError);
  });
});
