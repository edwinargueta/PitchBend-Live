// Music-theory utilities (§6.8): transposition, enharmonic spelling, capo hints,
// and readable formatting. Implemented by the web-lib workstream.
//
// The API only ever sends sharps-only canonical tonics (ADR 0005 §13). This module
// is the single place that decides how a key is spelled for people.
import type { Mode, PitchClass } from "./types";

export interface Key {
  tonic: PitchClass;
  mode: Mode;
}

/** The API's canonical pitch classes, in semitone order from C. */
export const PITCH_CLASSES: readonly PitchClass[] = [
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
];

export function isPitchClass(value: unknown): value is PitchClass {
  return (
    typeof value === "string" &&
    (PITCH_CLASSES as readonly string[]).includes(value)
  );
}

export function isMode(value: unknown): value is Mode {
  return value === "major" || value === "minor";
}

/** Transpose by a whole number of semitones; returns the canonical (sharps-only) key. */
export function transposeKey(
  tonic: PitchClass,
  mode: Mode,
  semitones: number,
): Key {
  assertWholeSemitones(semitones);
  assertMode(mode);
  return { tonic: pitchClassAt(pitchIndex(tonic) + semitones), mode };
}

/**
 * How each of the 24 keys is spelled, in ASCII ("#" / "b"). §6.8: prefer the
 * spelling whose key signature has fewer accidentals; flats for F, B♭, E♭, A♭,
 * D♭, G♭ majors and their relative minors (which settles the two 6-vs-6 ties).
 *
 *   API   major (sharp vs flat signature)      minor (sharp vs flat signature)
 *   C     C                                    C   (relative of E♭)
 *   C#    D♭  (C♯ 7♯ vs D♭ 5♭)                 C♯  (C♯ 4♯ vs D♭ 8♭)
 *   D     D                                    D   (relative of F)
 *   D#    E♭  (D♯ 9♯ vs E♭ 3♭)                 E♭  (D♯ 6♯ vs E♭ 6♭, tie: rule)
 *   E     E   (E 4♯ vs F♭ 8♭)                  E
 *   F     F                                    F   (relative of A♭)
 *   F#    G♭  (F♯ 6♯ vs G♭ 6♭, tie: rule)      F♯  (F♯ 3♯ vs G♭ 9♭)
 *   G     G                                    G   (relative of B♭)
 *   G#    A♭  (G♯ 8♯ vs A♭ 4♭)                 G♯  (G♯ 5♯ vs A♭ 7♭)
 *   A     A                                    A
 *   A#    B♭  (A♯ 10♯ vs B♭ 2♭)                B♭  (A♯ 7♯ vs B♭ 5♭)
 *   B     B   (B 5♯ vs C♭ 7♭)                  B
 */
const TONIC_SPELLING: Readonly<
  Record<Mode, Readonly<Record<PitchClass, string>>>
> = {
  major: {
    C: "C",
    "C#": "Db",
    D: "D",
    "D#": "Eb",
    E: "E",
    F: "F",
    "F#": "Gb",
    G: "G",
    "G#": "Ab",
    A: "A",
    "A#": "Bb",
    B: "B",
  },
  minor: {
    C: "C",
    "C#": "C#",
    D: "D",
    "D#": "Eb",
    E: "E",
    F: "F",
    "F#": "F#",
    G: "G",
    "G#": "G#",
    A: "A",
    "A#": "Bb",
    B: "B",
  },
};

type KeyStyle = "display" | "spoken" | "ascii";
type Accidental = "" | "#" | "b";

const ACCIDENTAL: Readonly<
  Record<Accidental, Readonly<Record<KeyStyle, string>>>
> = {
  "": { display: "", spoken: "", ascii: "" },
  "#": { display: "♯", spoken: " sharp", ascii: "#" },
  b: { display: "♭", spoken: " flat", ascii: "b" },
};

/**
 * The tonic as it should be displayed, e.g. "B♭" or "F♯". §6.8: prefer fewer
 * accidentals; flats for F, B♭, E♭, A♭, D♭, G♭ majors and their relative minors.
 */
export function spellTonic(tonic: PitchClass, mode: Mode): string {
  return tonicName(tonic, mode, "display");
}

/** "B♭ major" (display), "B flat major" (spoken, for aria-valuetext), "Bb major" (ascii, for filenames). */
export function formatKey(
  key: Key,
  style: "display" | "spoken" | "ascii" = "display",
): string {
  return `${tonicName(key.tonic, key.mode, style)} ${key.mode}`;
}

/** "+2", "−3", "0" (typographic minus). */
export function formatSemitones(semitones: number): string {
  assertWholeSemitones(semitones);
  if (semitones > 0) return `+${String(semitones)}`;
  if (semitones < 0) return `−${String(-semitones)}`;
  return "0"; // also for -0
}

/**
 * "G major → A major (+2)". The format is the same for every shift, so 0 gives
 * "G major → G major (0)" and ±12 gives the same key an octave away.
 */
export function formatTransposition(from: Key, semitones: number): string {
  const to = transposeKey(from.tonic, from.mode, semitones);
  return `${formatKey(from)} → ${formatKey(to)} (${formatSemitones(semitones)})`;
}

/**
 * The highest capo fret we suggest. Past the 7th fret the neck gets cramped and
 * the tone thin, so most guitarists would rather re-voice than capo that high.
 */
export const MAX_CAPO_FRET = 7;

/**
 * The capo fret that lets a guitarist play the shifted key with the original
 * chord shapes, or null when no practical capo position exists.
 *
 * A capo only raises pitch, so the fret is the shift mod 12:
 * - +1…+7 → fret 1…7 (the shifted key itself).
 * - −5…−11 → fret 7…1: the same key an octave up (e.g. −2 → fret 10 is too
 *   high, but −10 → fret 2).
 * - 0, ±12 (same key) and anything needing fret 8…11 (+8…+11, −1…−4) → null.
 * Shifts beyond ±12 wrap the same way.
 */
export function capoFret(semitones: number): number | null {
  assertWholeSemitones(semitones);
  const fret = mod12(semitones);
  return fret === 0 || fret > MAX_CAPO_FRET ? null : fret;
}

/** A guitarist's hint for playing the shifted key with the original shapes, or null at 0. */
export function capoHint(semitones: number): string | null {
  const fret = capoFret(semitones);
  return fret === null ? null : `Capo ${String(fret)}`;
}

// ---- internals ---------------------------------------------------------------

function tonicName(tonic: PitchClass, mode: Mode, style: KeyStyle): string {
  assertMode(mode);
  const ascii = TONIC_SPELLING[mode][pitchClassAt(pitchIndex(tonic))];
  // Every TONIC_SPELLING entry is a letter plus an optional "#" or "b".
  const accidental = ascii.slice(1) as Accidental;
  return `${ascii.charAt(0)}${ACCIDENTAL[accidental][style]}`;
}

function mod12(n: number): number {
  return ((n % 12) + 12) % 12;
}

function pitchIndex(tonic: PitchClass): number {
  const index = PITCH_CLASSES.indexOf(tonic);
  if (index < 0) throw new RangeError(`Unknown pitch class: ${tonic}`);
  return index;
}

function pitchClassAt(index: number): PitchClass {
  // mod12 keeps the index in 0..11, so the lookup always succeeds.
  return PITCH_CLASSES[mod12(index)] as PitchClass;
}

function assertMode(mode: Mode): void {
  if (!isMode(mode)) throw new RangeError(`Unknown mode: ${String(mode)}`);
}

function assertWholeSemitones(semitones: number): void {
  if (!Number.isInteger(semitones)) {
    throw new RangeError(
      `Semitones must be a whole number, got ${String(semitones)}`,
    );
  }
}
