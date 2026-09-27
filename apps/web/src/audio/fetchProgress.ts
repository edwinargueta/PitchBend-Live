import { EngineError } from "./errors";
import { isAbortError } from "./progress";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Downloads `url` into an ArrayBuffer, streaming the body so progress can be
 * reported as a 0..1 fraction. Without a usable Content-Length (or a readable
 * body) the only report is the final 1.
 *
 * Failures (no connection, an HTTP error, a body cut off mid-download) reject
 * with an EngineError of kind `network`. Aborting via `signal` rejects with
 * the AbortError itself, unclassified.
 */
export async function fetchWithProgress(
  fetchFn: FetchLike,
  url: string,
  signal: AbortSignal,
  onFraction: (fraction: number) => void,
): Promise<ArrayBuffer> {
  try {
    return await download(fetchFn, url, signal, onFraction);
  } catch (err) {
    if (signal.aborted && isAbortError(err)) throw err;
    if (err instanceof EngineError) throw err;
    throw new EngineError(
      "network",
      "Couldn't download the audio. Check your connection.",
      { cause: err },
    );
  }
}

async function download(
  fetchFn: FetchLike,
  url: string,
  signal: AbortSignal,
  onFraction: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetchFn(url, { signal, credentials: "same-origin" });
  if (!response.ok) {
    throw new EngineError(
      "network",
      `Couldn't download the audio (HTTP ${String(response.status)}).`,
    );
  }
  const total = Number(response.headers.get("content-length") ?? "");
  const known = Number.isFinite(total) && total > 0;

  if (!response.body) {
    const data = await response.arrayBuffer();
    onFraction(1);
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    // Content-Length can undercount (e.g. compressed transfer), hence the cap.
    if (known) onFraction(Math.min(1, received / total));
  }
  onFraction(1);
  return concat(chunks, received);
}

function concat(chunks: readonly Uint8Array[], size: number): ArrayBuffer {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
