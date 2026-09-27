/** "3:07", or "1:02:03" past an hour. Invalid or negative input reads "0:00". */
export function formatTime(seconds: number): string {
  const total =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0
    ? `${String(h)}:${String(m).padStart(2, "0")}:${s}`
    : `${String(m)}:${s}`;
}

/** "1 minute 5 seconds", for screen readers. */
export function spokenTime(seconds: number): string {
  const total =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  const part = (n: number, unit: string) =>
    `${String(n)} ${unit}${n === 1 ? "" : "s"}`;
  if (m === 0) return part(s, "second");
  return s === 0
    ? part(m, "minute")
    : `${part(m, "minute")} ${part(s, "second")}`;
}
