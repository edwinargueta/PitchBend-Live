/** "−12 cents", "+7 cents", "0 cents" (typographic minus). */
export function formatCents(cents: number): string {
  const sign = cents > 0 ? "+" : cents < 0 ? "−" : "";
  return `${sign}${String(Math.abs(cents))} cents`;
}
