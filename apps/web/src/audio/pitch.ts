// Pitch parameter rules (§6.8) and the click-free ramp (§10 B3).
//
// Validation policy (documented on AudioEngine.setSemitones / setCents):
//  - non-finite values (NaN, ±Infinity) are programming errors: RangeError;
//  - semitones are rounded to the nearest integer, then clamped to -12..+12;
//  - cents are clamped to -50..+50 (fractions are kept).

export const SEMITONES_MIN = -12;
export const SEMITONES_MAX = 12;
export const CENTS_MIN = -50;
export const CENTS_MAX = 50;

/** A live pitch change glides to its target over this long (spec: 30–50 ms). */
export const RAMP_MS = 40;
/** Number of parameter updates sent during one ramp. */
export const RAMP_STEPS = 4;

function clamp(value: number, min: number, max: number): number {
  // `+ 0` turns -0 into 0 so callers never see a negative zero.
  return Math.min(max, Math.max(min, value)) + 0;
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `${name} must be a finite number, got ${String(value)}`,
    );
  }
}

export function normalizeSemitones(n: number): number {
  assertFinite("semitones", n);
  return clamp(Math.round(n), SEMITONES_MIN, SEMITONES_MAX);
}

export function normalizeCents(n: number): number {
  assertFinite("cents", n);
  return clamp(n, CENTS_MIN, CENTS_MAX);
}

/** The single pitch-shift amount the stretch node takes, in semitones. */
export function totalShift(semitones: number, cents: number): number {
  return semitones + cents / 100;
}

export interface RampStep {
  /** Delay from the start of the ramp. */
  atMs: number;
  value: number;
}

/**
 * Evenly spaced steps from `from` (exclusive) to `to` (inclusive). The first
 * step is immediate, so a change starts being heard at once, and the last lands
 * on the exact target at `durationMs`.
 */
export function planRamp(
  from: number,
  to: number,
  durationMs: number,
  steps: number,
): RampStep[] {
  const count = Math.max(1, Math.floor(steps));
  if (count === 1) return [{ atMs: 0, value: to }];
  const plan: RampStep[] = [];
  for (let k = 1; k <= count; k++) {
    plan.push({
      atMs: (durationMs * (k - 1)) / (count - 1),
      value: k === count ? to : from + ((to - from) * k) / count,
    });
  }
  return plan;
}
