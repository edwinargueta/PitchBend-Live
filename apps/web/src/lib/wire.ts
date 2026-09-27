// Small helpers for decoding untrusted JSON from the API (REST bodies, SSE data).

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.parse that returns undefined instead of throwing on malformed input. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
