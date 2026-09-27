// REST client for /api (§6.4, ADR 0005). Implemented by the web-lib workstream.
//
// Failure model (every function):
// - Non-2xx with a §6.6 body → ApiError(code, server message, status, retryAfterS).
// - Non-2xx without one (e.g. a proxy error page) → ApiError("INTERNAL"), except
//   413 → FILE_TOO_LARGE (the Ingress body limit) and 429 → RATE_LIMITED.
// - A 2xx body that isn't the expected JSON → ApiError("INTERNAL", …, status).
// - Network failure → ApiError("INTERNAL", …, 0).
// - Abort → the abort reason itself (a DOMException named "AbortError" unless the
//   caller passed a custom reason), never wrapped. See isAbortError.
import { describeError, isErrorCode } from "./errors";
import type { ErrorCode, JobCreated, Track } from "./types";
import { isRecord, parseJson } from "./wire";

/** A non-2xx response, decoded from the §6.6 error body. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Seconds to wait, for RATE_LIMITED. */
  readonly retryAfterS: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    retryAfterS?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

export const NETWORK_ERROR_MESSAGE =
  "Couldn’t reach the server. Check your connection and try again.";

/** True for the rejection of an aborted request (checks the name, so it works across realms). */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    err.name === "AbortError"
  );
}

/** POST /api/jobs {url}. Resolves 200 (cache hit) and 202 alike; rejects with ApiError. */
export async function createJob(
  url: string,
  init?: { signal?: AbortSignal },
): Promise<JobCreated> {
  const res = await request("/api/jobs", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal: init?.signal,
  });
  return toJobCreated(res);
}

/** POST /api/uploads (multipart field "file"), reporting upload progress 0..100. */
export function uploadFile(
  file: File,
  opts?: { onProgress?: (pct: number) => void; signal?: AbortSignal },
): Promise<JobCreated> {
  const signal = opts?.signal;
  const onProgress = opts?.onProgress;
  return new Promise<JobCreated>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    // XMLHttpRequest, not fetch: only XHR reports upload progress everywhere.
    const xhr = new XMLHttpRequest();
    let lastPct = -1;
    const report = (pct: number): void => {
      // Whole percentages, never backwards, and only when the value changes.
      const whole = Math.min(100, Math.max(0, Math.floor(pct)));
      if (whole > lastPct) {
        lastPct = whole;
        onProgress?.(whole);
      }
    };
    const onAbortSignal = (): void => {
      xhr.abort();
    };
    const settle = (): void => {
      signal?.removeEventListener("abort", onAbortSignal);
    };

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && e.total > 0) report((e.loaded / e.total) * 100);
    });
    xhr.upload.addEventListener("load", () => {
      report(100);
    });
    xhr.addEventListener("load", () => {
      settle();
      const res: RawResponse = {
        status: xhr.status,
        text: xhr.responseText,
        retryAfter: xhr.getResponseHeader("Retry-After"),
      };
      // Rejects with toJobCreated's ApiError when the response isn't a success.
      resolve(Promise.resolve(res).then(toJobCreated));
    });
    xhr.addEventListener("error", () => {
      settle();
      reject(new ApiError("INTERNAL", NETWORK_ERROR_MESSAGE, 0));
    });
    xhr.addEventListener("abort", () => {
      settle();
      reject(abortReason(signal));
    });

    signal?.addEventListener("abort", onAbortSignal, { once: true });
    xhr.open("POST", "/api/uploads");
    xhr.setRequestHeader("Accept", "application/json");
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

/** GET /api/tracks/{track_id}; rejects with ApiError NOT_FOUND for unknown/expired tracks. */
export async function getTrack(
  trackId: string,
  init?: { signal?: AbortSignal },
): Promise<Track> {
  const res = await request(`/api/tracks/${encodeURIComponent(trackId)}`, {
    headers: { Accept: "application/json" },
    signal: init?.signal,
  });
  const body = okBody(res);
  if (isRecord(body) && typeof body.track_id === "string") {
    return body as unknown as Track;
  }
  throw unexpectedResponse(res.status);
}

/** An IMF-fixdate, the HTTP-date form servers send: "Sun, 06 Nov 1994 08:49:37 GMT". */
const HTTP_DATE =
  /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Seconds from a Retry-After header: delta-seconds ("120") or an HTTP-date
 * (seconds from `now`, at least 0). Undefined when absent or unparseable.
 */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  // Date.parse alone is far too lenient (it accepts "1.5" and "-5").
  const date = HTTP_DATE.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

// ---- internals ---------------------------------------------------------------

/** The parts of an HTTP response this client uses, from fetch or XHR alike. */
interface RawResponse {
  status: number;
  text: string;
  retryAfter: string | null;
}

async function request(path: string, init: RequestInit): Promise<RawResponse> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw transportError(err, init.signal, 0);
  }
  try {
    const text = await res.text();
    return {
      status: res.status,
      text,
      retryAfter: res.headers.get("Retry-After"),
    };
  } catch (err) {
    throw transportError(err, init.signal, res.status);
  }
}

/** An abort passes through untouched; anything else is a network failure. */
function transportError(
  err: unknown,
  signal: AbortSignal | null | undefined,
  status: number,
): Error {
  if (isAbortError(err) || signal?.aborted) return err as Error;
  return new ApiError("INTERNAL", NETWORK_ERROR_MESSAGE, status);
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason === undefined
    ? new DOMException("The upload was aborted.", "AbortError")
    : (reason as Error);
}

/** The parsed JSON body of a 2xx response; throws ApiError for anything else. */
function okBody(res: RawResponse): unknown {
  if (res.status < 200 || res.status > 299) throw errorFromResponse(res);
  const body = parseJson(res.text);
  if (body === undefined) throw unexpectedResponse(res.status);
  return body;
}

function toJobCreated(res: RawResponse): JobCreated {
  const body = okBody(res);
  if (
    isRecord(body) &&
    typeof body.job_id === "string" &&
    typeof body.track_id === "string"
  ) {
    // §6.4 sends "done" (200) or "queued" (202); fall back on the HTTP status.
    const status =
      body.status === "done" || body.status === "queued"
        ? body.status
        : res.status === 200
          ? "done"
          : "queued";
    return { job_id: body.job_id, track_id: body.track_id, status };
  }
  throw unexpectedResponse(res.status);
}

function errorFromResponse(res: RawResponse): ApiError {
  const headerRetry = parseRetryAfter(res.retryAfter);
  const body = parseJson(res.text);
  if (isRecord(body) && isRecord(body.error) && isErrorCode(body.error.code)) {
    const { code, message, retry_after_s: retry } = body.error;
    const retryAfterS =
      typeof retry === "number" && Number.isFinite(retry) && retry >= 0
        ? Math.ceil(retry)
        : headerRetry;
    const text =
      typeof message === "string" && message.trim() !== ""
        ? message
        : describeError(code, retryAfterS).message;
    return new ApiError(code, text, res.status, retryAfterS);
  }
  // Not a §6.6 body (a proxy error page, an empty body, or an unknown code).
  if (res.status === 413 || res.status === 429) {
    const code = res.status === 413 ? "FILE_TOO_LARGE" : "RATE_LIMITED";
    return new ApiError(
      code,
      describeError(code, headerRetry).message,
      res.status,
      headerRetry,
    );
  }
  return unexpectedResponse(res.status, headerRetry);
}

function unexpectedResponse(status: number, retryAfterS?: number): ApiError {
  return new ApiError(
    "INTERNAL",
    `The server sent an unexpected response (HTTP ${String(status)}). Please try again.`,
    status,
    retryAfterS,
  );
}
