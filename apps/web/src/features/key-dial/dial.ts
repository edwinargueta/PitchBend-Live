// Geometry and wording for the key dial (§10 C4). Pure, so it's unit-testable.

export const MIN_SEMITONES = -12;
export const MAX_SEMITONES = 12;
/** The dial sweeps ±135° from 12 o'clock; the gap at the bottom is dead space. */
export const SWEEP_DEG = 135;

export function clampSemitones(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_SEMITONES, Math.max(MIN_SEMITONES, Math.round(n)));
}

/** Angle in degrees (0 = 12 o'clock, clockwise positive) for a value. */
export function valueToAngle(value: number): number {
  return (clampSemitones(value) / MAX_SEMITONES) * SWEEP_DEG;
}

/** The snapped value for a pointer at (dx, dy) from the dial's centre (y grows downwards). */
export function pointToValue(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI; // -180..180, 0 at the top
  const clamped = Math.max(-SWEEP_DEG, Math.min(SWEEP_DEG, angle));
  return clampSemitones((clamped / SWEEP_DEG) * MAX_SEMITONES);
}

/** A point on a circle of radius r around (cx, cy) at the given dial angle. */
export function polar(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

/** SVG path for an arc between two dial angles (clockwise). */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  fromDeg: number,
  toDeg: number,
): string {
  const start = polar(cx, cy, r, fromDeg);
  const end = polar(cx, cy, r, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const f = (n: number) => n.toFixed(2);
  return `M ${f(start.x)} ${f(start.y)} A ${f(r)} ${f(r)} 0 ${String(large)} 1 ${f(end.x)} ${f(end.y)}`;
}

/** "Plus 2 semitones", "Minus 1 semitone", "Original key". */
export function spokenShift(semitones: number): string {
  if (semitones === 0) return "Original key";
  const n = Math.abs(semitones);
  return `${semitones > 0 ? "Plus" : "Minus"} ${String(n)} semitone${n === 1 ? "" : "s"}`;
}

/** aria-valuetext, e.g. "Plus 2 semitones, A major". */
export function dialValueText(
  semitones: number,
  spokenKey: string | null,
): string {
  const shift = spokenShift(semitones);
  return spokenKey ? `${shift}, ${spokenKey}` : shift;
}
