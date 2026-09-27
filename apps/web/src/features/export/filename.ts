// Export filenames: "<title> (<new key, ascii>, +2).wav" (§10 C6).
// Titles are untrusted (ADR 0005 §12), so everything is sanitized here.

const MAX_TITLE_LENGTH = 100;
const FALLBACK_TITLE = "KeyShift export";

/** A title safe for a download filename on Windows, macOS and Linux. */
export function sanitizeFilename(input: string | null | undefined): string {
  const cleaned = (input ?? "")
    // Control characters (tabs, newlines, NUL…) become spaces, collapsed below.
    // eslint-disable-next-line no-control-regex -- matching control chars is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const capped = Array.from(cleaned).slice(0, MAX_TITLE_LENGTH).join("").trim();
  return capped === "" ? FALLBACK_TITLE : capped;
}

/** "+2", "-3", "0" with an ASCII sign, for filenames. */
export function asciiSemitones(semitones: number): string {
  return semitones > 0 ? `+${String(semitones)}` : String(semitones);
}

export function exportFilename(
  title: string | null | undefined,
  semitones: number,
  newKeyAscii: string | null,
): string {
  const shift = asciiSemitones(semitones);
  const detail = newKeyAscii
    ? `${sanitizeFilename(newKeyAscii)}, ${shift}`
    : shift;
  return `${sanitizeFilename(title)} (${detail}).wav`;
}
