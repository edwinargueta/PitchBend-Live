import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  ApiError,
  NETWORK_ERROR_MESSAGE,
  createJob,
  getTrack,
  isAbortError,
  parseRetryAfter,
  uploadFile,
} from "./api";
import { describeError } from "./errors";
import type { Track } from "./types";

const JOB = { job_id: "job-1", track_id: "track-1" };

const TRACK: Track = {
  track_id: "track-1",
  source: "youtube",
  title: "Song",
  duration_s: 213.4,
  status: "ready",
  audio_url: "/media/abc.m4a",
  key: {
    tonic: "G",
    mode: "major",
    confidence: 0.82,
    alternates: [{ tonic: "E", mode: "minor", confidence: 0.71 }],
    tuning_cents: -12,
  },
  expires_at: "2026-09-26T12:00:00Z",
};

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function errorBody(code: string, message = "server says no", extra = {}) {
  return { error: { code, message, ...extra } };
}

/** Awaits a promise that must reject, and returns the rejection. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const err = await rejection(promise);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

/** A fetch that never settles until its signal aborts, like a slow server. */
function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => {
        reject(signal.reason as Error);
      });
    });
}

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiError", () => {
  it("carries code, status and retryAfterS", () => {
    const err = new ApiError("RATE_LIMITED", "slow down", 429, 30);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ApiError");
    expect(err.message).toBe("slow down");
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.status).toBe(429);
    expect(err.retryAfterS).toBe(30);
    expect(new ApiError("INTERNAL", "x", 500).retryAfterS).toBeUndefined();
  });
});

describe("isAbortError", () => {
  it("recognizes AbortErrors from any realm", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(controller.signal.reason)).toBe(true);
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });

  it.each([
    new Error("x"),
    new ApiError("INTERNAL", "x", 0),
    new DOMException("x", "TimeoutError"),
    "AbortError",
    null,
    undefined,
    {},
  ])("rejects %s", (value) => {
    expect(isAbortError(value)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");

  it.each([
    [null, undefined],
    ["", undefined],
    ["soon", undefined],
    ["-5", undefined],
    ["1.5", undefined],
    ["0", 0],
    ["120", 120],
    [" 30 ", 30],
    ["Sat, 26 Sep 2026 12:01:30 GMT", 90],
    ["Sat, 26 Sep 2026 11:59:00 GMT", 0],
    ["Sat, 26 Sep 2026 12:01:30", undefined], // not GMT
    ["2026-09-26T12:01:30Z", undefined], // not an HTTP-date
    ["Sat, 99 Sep 2026 12:01:30 GMT", undefined], // right shape, invalid date
  ])("%j → %s", (header, expected) => {
    expect(parseRetryAfter(header, now)).toBe(expected);
  });

  it("defaults to the current time", () => {
    const inOneMinute = new Date(Date.now() + 60_000).toUTCString();
    const seconds = parseRetryAfter(inOneMinute);
    expect(seconds).toBeGreaterThanOrEqual(58);
    expect(seconds).toBeLessThanOrEqual(60);
  });
});

describe("createJob", () => {
  it("POSTs JSON {url} to /api/jobs", async () => {
    fetchMock.mockResolvedValue(json(202, { ...JOB, status: "queued" }));
    await createJob("https://youtu.be/dQw4w9WgXcQ");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/jobs");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    expect(init?.body).toBe(
      JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }),
    );
  });

  it("resolves a 202 cache miss", async () => {
    fetchMock.mockResolvedValue(json(202, { ...JOB, status: "queued" }));
    await expect(createJob("u")).resolves.toEqual({ ...JOB, status: "queued" });
  });

  it("resolves a 200 cache hit the same way", async () => {
    fetchMock.mockResolvedValue(json(200, { ...JOB, status: "done" }));
    await expect(createJob("u")).resolves.toEqual({ ...JOB, status: "done" });
  });

  it("keeps only the contract fields", async () => {
    fetchMock.mockResolvedValue(
      json(200, { ...JOB, status: "done", extra: 1 }),
    );
    await expect(createJob("u")).resolves.toEqual({ ...JOB, status: "done" });
  });

  it.each([
    [200, "done"],
    [202, "queued"],
    [201, "queued"],
  ])(
    "derives a missing or unknown status from HTTP %i → %s",
    async (status, expected) => {
      fetchMock.mockResolvedValueOnce(json(status, JOB));
      await expect(createJob("u")).resolves.toEqual({
        ...JOB,
        status: expected,
      });
      fetchMock.mockResolvedValueOnce(
        json(status, { ...JOB, status: "running" }),
      );
      await expect(createJob("u")).resolves.toEqual({
        ...JOB,
        status: expected,
      });
    },
  );

  it("passes the abort signal to fetch", async () => {
    fetchMock.mockResolvedValue(json(202, { ...JOB, status: "queued" }));
    const controller = new AbortController();
    await createJob("u", { signal: controller.signal });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it.each([
    ["INVALID_URL", 400],
    ["SOURCE_BLOCKED", 502],
    ["VIDEO_TOO_LONG", 422],
    ["LIVESTREAM", 422],
    ["SOURCE_UNAVAILABLE", 422],
    ["INTERNAL", 500],
  ] as const)("rejects %s (%i) as ApiError", async (code, status) => {
    fetchMock.mockResolvedValue(json(status, errorBody(code, "nope")));
    const err = await apiError(createJob("u"));
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toBe("nope");
    expect(err.retryAfterS).toBeUndefined();
  });

  it("reads retry_after_s from the RATE_LIMITED body", async () => {
    fetchMock.mockResolvedValue(
      json(429, errorBody("RATE_LIMITED", "slow", { retry_after_s: 42 }), {
        "Retry-After": "99",
      }),
    );
    const err = await apiError(createJob("u"));
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.status).toBe(429);
    expect(err.retryAfterS).toBe(42);
  });

  it("rounds a fractional retry_after_s up", async () => {
    fetchMock.mockResolvedValue(
      json(429, errorBody("RATE_LIMITED", "slow", { retry_after_s: 41.2 })),
    );
    expect((await apiError(createJob("u"))).retryAfterS).toBe(42);
  });

  it.each([undefined, "12", -1, Number.NaN])(
    "falls back to the Retry-After header when retry_after_s is %j",
    async (retry) => {
      fetchMock.mockResolvedValue(
        json(429, errorBody("RATE_LIMITED", "slow", { retry_after_s: retry }), {
          "Retry-After": "77",
        }),
      );
      expect((await apiError(createJob("u"))).retryAfterS).toBe(77);
    },
  );

  it("leaves retryAfterS undefined when neither is present", async () => {
    fetchMock.mockResolvedValue(json(429, errorBody("RATE_LIMITED")));
    expect((await apiError(createJob("u"))).retryAfterS).toBeUndefined();
  });

  it.each([undefined, "", "   ", 42])(
    "uses friendly copy when the message is %j",
    async (message) => {
      fetchMock.mockResolvedValue(
        json(400, { error: { code: "INVALID_URL", message } }),
      );
      const err = await apiError(createJob("u"));
      expect(err.code).toBe("INVALID_URL");
      expect(err.message).toBe(describeError("INVALID_URL").message);
    },
  );

  it.each([
    ["an HTML error page", "<html>Bad Gateway</html>", 502],
    ["an empty body", "", 500],
    ["JSON without error", JSON.stringify({ detail: "x" }), 422],
    ["an unknown code", JSON.stringify(errorBody("NEW_CODE")), 400],
    ["a non-object error", JSON.stringify({ error: "INVALID_URL" }), 400],
  ])("maps %s to INTERNAL with the status", async (_label, body, status) => {
    fetchMock.mockResolvedValue(new Response(body, { status }));
    const err = await apiError(createJob("u"));
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(status);
    expect(err.message).toContain(`HTTP ${String(status)}`);
  });

  it("maps a non-JSON 413 (the Ingress body limit) to FILE_TOO_LARGE", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>413 Request Entity Too Large</html>", {
        status: 413,
      }),
    );
    const err = await apiError(createJob("u"));
    expect(err.code).toBe("FILE_TOO_LARGE");
    expect(err.status).toBe(413);
    expect(err.message).toBe(describeError("FILE_TOO_LARGE").message);
  });

  it("maps a non-JSON 429 to RATE_LIMITED with the header's wait", async () => {
    fetchMock.mockResolvedValue(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    );
    const err = await apiError(createJob("u"));
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryAfterS).toBe(120);
    expect(err.message).toContain("2 minutes");
  });

  it("keeps a Retry-After header on other non-JSON errors", async () => {
    fetchMock.mockResolvedValue(
      new Response("down", { status: 503, headers: { "Retry-After": "5" } }),
    );
    const err = await apiError(createJob("u"));
    expect(err.code).toBe("INTERNAL");
    expect(err.retryAfterS).toBe(5);
  });

  it.each([
    ["non-JSON", "<html>ok</html>"],
    ["an empty body", ""],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["missing job_id", JSON.stringify({ track_id: "t", status: "done" })],
    ["numeric ids", JSON.stringify({ job_id: 1, track_id: 2, status: "done" })],
  ])("rejects a 2xx with %s as INTERNAL", async (_label, body) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    const err = await apiError(createJob("u"));
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(200);
  });

  it("maps a network failure to INTERNAL with status 0", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await apiError(createJob("u"));
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(0);
    expect(err.message).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("maps a failure while reading the body to INTERNAL with the status", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => Promise.reject(new TypeError("connection reset")),
    } as unknown as Response);
    const err = await apiError(createJob("u"));
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(200);
  });

  it("rejects with the AbortError, unwrapped, when aborted mid-request", async () => {
    fetchMock.mockImplementation(hangingFetch());
    const controller = new AbortController();
    const pending = createJob("u", { signal: controller.signal });
    controller.abort();
    const err = await rejection(pending);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(isAbortError(err)).toBe(true);
  });

  it("passes through an abort while reading the body", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: () => {
        controller.abort();
        return Promise.reject(controller.signal.reason as Error);
      },
    } as unknown as Response);
    const err = await rejection(createJob("u", { signal: controller.signal }));
    expect(isAbortError(err)).toBe(true);
  });

  it("passes through a custom abort reason", async () => {
    fetchMock.mockImplementation(hangingFetch());
    const controller = new AbortController();
    const reason = new Error("user navigated away");
    const pending = createJob("u", { signal: controller.signal });
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
  });
});

describe("getTrack", () => {
  it("GETs /api/tracks/{id} and resolves the track", async () => {
    fetchMock.mockResolvedValue(json(200, TRACK));
    await expect(getTrack("track-1")).resolves.toEqual(TRACK);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/tracks/track-1");
    expect(init?.method).toBeUndefined();
    expect(init?.headers).toEqual({ Accept: "application/json" });
  });

  it("encodes the id into the path", async () => {
    fetchMock.mockResolvedValue(json(200, TRACK));
    await getTrack("../jobs?x=1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tracks/..%2Fjobs%3Fx%3D1");
  });

  it("passes the abort signal", async () => {
    fetchMock.mockResolvedValue(json(200, TRACK));
    const controller = new AbortController();
    await getTrack("t", { signal: controller.signal });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("rejects NOT_FOUND for unknown or expired tracks", async () => {
    fetchMock.mockResolvedValue(json(404, errorBody("NOT_FOUND", "gone")));
    const err = await apiError(getTrack("nope"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
  });

  it.each([
    ["non-JSON", "oops"],
    ["no track_id", JSON.stringify({ status: "ready" })],
  ])("rejects a 200 with %s as INTERNAL", async (_label, body) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    expect((await apiError(getTrack("t"))).code).toBe("INTERNAL");
  });

  it("maps a network failure to INTERNAL with status 0", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const err = await apiError(getTrack("t"));
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(0);
  });

  it("passes an abort through", async () => {
    fetchMock.mockImplementation(hangingFetch());
    const controller = new AbortController();
    const pending = getTrack("t", { signal: controller.signal });
    controller.abort();
    expect(isAbortError(await rejection(pending))).toBe(true);
  });
});

// ---- uploadFile (XMLHttpRequest) -----------------------------------------------

class FakeXHR extends EventTarget {
  static instances: FakeXHR[] = [];

  readonly upload = new EventTarget();
  method = "";
  url = "";
  readonly requestHeaders: Record<string, string> = {};
  body: unknown = undefined;
  sent = false;
  aborted = false;
  status = 0;
  responseText = "";
  private responseHeaders: Record<string, string> = {};

  constructor() {
    super();
    FakeXHR.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }

  send(body: unknown): void {
    this.body = body;
    this.sent = true;
  }

  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new Event("abort"));
  }

  // -- test controls --

  progress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.dispatchEvent(
      new ProgressEvent("progress", { loaded, total, lengthComputable }),
    );
  }

  respond(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    this.upload.dispatchEvent(new ProgressEvent("load"));
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.responseHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    this.dispatchEvent(new ProgressEvent("load"));
  }

  networkError(): void {
    this.dispatchEvent(new ProgressEvent("error"));
  }
}

function lastXhr(): FakeXHR {
  const xhr = FakeXHR.instances.at(-1);
  if (!xhr) throw new Error("no XMLHttpRequest was created");
  return xhr;
}

describe("uploadFile", () => {
  const file = new File(["fake audio"], "My Song.mp3", { type: "audio/mpeg" });

  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
  });

  it('POSTs multipart field "file" to /api/uploads', async () => {
    const pending = uploadFile(file);
    const xhr = lastXhr();
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/uploads");
    expect(xhr.requestHeaders).toEqual({ Accept: "application/json" });
    expect(xhr.sent).toBe(true);
    expect(xhr.body).toBeInstanceOf(FormData);
    const sent = (xhr.body as FormData).get("file");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("My Song.mp3");
    expect([...(xhr.body as FormData).keys()]).toEqual(["file"]);

    xhr.respond(202, { ...JOB, status: "queued" });
    await expect(pending).resolves.toEqual({ ...JOB, status: "queued" });
  });

  it("resolves a 200 cache hit", async () => {
    const pending = uploadFile(file);
    lastXhr().respond(200, { ...JOB, status: "done" });
    await expect(pending).resolves.toEqual({ ...JOB, status: "done" });
  });

  it("reports whole-number, non-decreasing progress 0..100", async () => {
    const onProgress = vi.fn<(pct: number) => void>();
    const pending = uploadFile(file, { onProgress });
    const xhr = lastXhr();
    xhr.progress(0, 1000);
    xhr.progress(1, 1000); // 0.1% → still 0, not repeated
    xhr.progress(255, 1000);
    xhr.progress(259, 1000); // 25.9% → still 25, not repeated
    xhr.progress(100, 1000); // going backwards is ignored
    xhr.progress(500, 0, false); // not computable
    xhr.progress(0, 0); // zero total
    xhr.progress(999, 1000);
    xhr.progress(2000, 1000); // clamped
    xhr.respond(202, { ...JOB, status: "queued" });
    await pending;
    expect(onProgress.mock.calls.map(([pct]) => pct)).toEqual([0, 25, 99, 100]);
  });

  it("reports 100 when the upload finishes even without progress events", async () => {
    const onProgress = vi.fn<(pct: number) => void>();
    const pending = uploadFile(file, { onProgress });
    lastXhr().respond(202, { ...JOB, status: "queued" });
    await pending;
    expect(onProgress.mock.calls).toEqual([[100]]);
  });

  it("works without an onProgress callback", async () => {
    const pending = uploadFile(file, {});
    const xhr = lastXhr();
    xhr.progress(10, 100);
    xhr.respond(202, { ...JOB, status: "queued" });
    await expect(pending).resolves.toBeTruthy();
  });

  it.each([
    ["UNSUPPORTED_FILE", 400],
    ["FILE_TOO_LARGE", 413],
    ["VIDEO_TOO_LONG", 422],
  ] as const)("rejects %s (%i) as ApiError", async (code, status) => {
    const pending = uploadFile(file);
    lastXhr().respond(status, errorBody(code, "nope"));
    const err = await apiError(pending);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toBe("nope");
  });

  it("reads RATE_LIMITED retry_after_s, or else the header", async () => {
    let pending = uploadFile(file);
    lastXhr().respond(
      429,
      errorBody("RATE_LIMITED", "slow", { retry_after_s: 12 }),
      { "Retry-After": "99" },
    );
    expect((await apiError(pending)).retryAfterS).toBe(12);

    pending = uploadFile(file);
    lastXhr().respond(429, errorBody("RATE_LIMITED"), { "Retry-After": "99" });
    expect((await apiError(pending)).retryAfterS).toBe(99);
  });

  it("maps an Ingress 413 page to FILE_TOO_LARGE", async () => {
    const pending = uploadFile(file);
    lastXhr().respond(413, "<html>413 Request Entity Too Large</html>");
    const err = await apiError(pending);
    expect(err.code).toBe("FILE_TOO_LARGE");
    expect(err.status).toBe(413);
  });

  it("maps a non-JSON error to INTERNAL", async () => {
    const pending = uploadFile(file);
    lastXhr().respond(502, "<html>Bad Gateway</html>");
    const err = await apiError(pending);
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(502);
  });

  it("maps a non-JSON 2xx to INTERNAL", async () => {
    const pending = uploadFile(file);
    lastXhr().respond(202, "accepted!");
    expect((await apiError(pending)).code).toBe("INTERNAL");
  });

  it("maps a network failure to INTERNAL with status 0", async () => {
    const pending = uploadFile(file);
    lastXhr().networkError();
    const err = await apiError(pending);
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(0);
    expect(err.message).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("aborts the request when the signal fires", async () => {
    const controller = new AbortController();
    const pending = uploadFile(file, { signal: controller.signal });
    const xhr = lastXhr();
    controller.abort();
    const err = await rejection(pending);
    expect(xhr.aborted).toBe(true);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(isAbortError(err)).toBe(true);
  });

  it("rejects with a custom abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const pending = uploadFile(file, { signal: controller.signal });
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
  });

  it("rejects with an AbortError when the XHR aborts on its own", async () => {
    const pending = uploadFile(file);
    lastXhr().abort();
    const err = await rejection(pending);
    expect(isAbortError(err)).toBe(true);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it("rejects immediately, without a request, if already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(
      uploadFile(file, { signal: controller.signal }),
    );
    expect(isAbortError(err)).toBe(true);
    expect(FakeXHR.instances).toHaveLength(0);
  });

  it("stops listening to the signal once settled", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const pending = uploadFile(file, { signal: controller.signal });
    const xhr = lastXhr();
    xhr.respond(202, { ...JOB, status: "queued" });
    await pending;
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(xhr.aborted).toBe(false);
  });
});
