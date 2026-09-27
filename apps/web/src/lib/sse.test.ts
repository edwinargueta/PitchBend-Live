import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONSECUTIVE_FAILURES,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  subscribeToJob,
  type JobEventHandlers,
} from "./sse";
import type { AudioReadyEvent, KeyReadyEvent, ProgressEvent } from "./types";

/** A controllable stand-in for the browser's EventSource (jsdom has none). */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  // -- test controls (deliberately usable even after close(), to prove the
  //    client ignores late events) --

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  emit(type: string, data: unknown): void {
    this.dispatchEvent(
      new MessageEvent(type, {
        data: typeof data === "string" ? data : JSON.stringify(data),
      }),
    );
  }

  /** A transport error; the browser either retries (CONNECTING) or gives up (CLOSED). */
  fail(readyState: number = FakeEventSource.CONNECTING): void {
    this.readyState = readyState;
    this.dispatchEvent(new Event("error"));
  }
}

function last(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error("no EventSource was created");
  return es;
}

const PROGRESS: ProgressEvent = { stage: "fetching", pct: 40 };
const AUDIO: AudioReadyEvent = {
  track_id: "track-1",
  audio_url: "/media/abc.m4a",
  duration_s: 213.4,
  title: "Song",
};
const KEY: KeyReadyEvent = {
  tonic: "G",
  mode: "major",
  confidence: 0.82,
  alternates: [
    { tonic: "E", mode: "minor", confidence: 0.71 },
    { tonic: "D", mode: "major", confidence: 0.4 },
  ],
  tuning_cents: -12,
};

function spies() {
  return {
    onProgress: vi.fn<(e: ProgressEvent) => void>(),
    onAudioReady: vi.fn<(e: AudioReadyEvent) => void>(),
    onKeyReady: vi.fn<(e: KeyReadyEvent) => void>(),
    onDone: vi.fn<() => void>(),
    onError: vi.fn<NonNullable<JobEventHandlers["onError"]>>(),
    onConnectionError: vi.fn<() => void>(),
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("subscribeToJob: events", () => {
  it("connects to /api/jobs/{id}/events, encoding the id", () => {
    subscribeToJob("job-1", {});
    expect(last().url).toBe("/api/jobs/job-1/events");
    subscribeToJob("a/b?c", {});
    expect(last().url).toBe("/api/jobs/a%2Fb%3Fc/events");
  });

  it("delivers the happy path in order and closes on done", () => {
    const h = spies();
    const order: string[] = [];
    subscribeToJob("job-1", {
      onProgress: (e) => order.push(`progress:${e.stage}`),
      onAudioReady: () => order.push("audio_ready"),
      onKeyReady: () => order.push("key_ready"),
      onDone: () => {
        // The stream is already closed when onDone runs.
        order.push(`done:closed=${String(last().closed)}`);
        h.onDone();
      },
    });
    const es = last();
    es.open();
    es.emit("progress", { stage: "queued", pct: null });
    es.emit("progress", { stage: "fetching", pct: 10 });
    es.emit("progress", { stage: "processing", pct: null });
    es.emit("audio_ready", AUDIO);
    es.emit("progress", { stage: "analyzing", pct: null });
    es.emit("key_ready", KEY);
    es.emit("done", {});
    expect(order).toEqual([
      "progress:queued",
      "progress:fetching",
      "progress:processing",
      "audio_ready",
      "progress:analyzing",
      "key_ready",
      "done:closed=true",
    ]);
    expect(es.closed).toBe(true);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("passes payloads through", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const es = last();
    es.emit("progress", PROGRESS);
    es.emit("audio_ready", AUDIO);
    es.emit("key_ready", KEY);
    expect(h.onProgress).toHaveBeenCalledWith(PROGRESS);
    expect(h.onAudioReady).toHaveBeenCalledWith(AUDIO);
    expect(h.onKeyReady).toHaveBeenCalledWith(KEY);
  });

  it("works with no handlers at all", () => {
    subscribeToJob("job-1", {});
    const es = last();
    es.emit("progress", PROGRESS);
    es.emit("audio_ready", AUDIO);
    es.emit("key_ready", KEY);
    es.emit("error", { code: "KEY_DETECTION_FAILED", message: "x" });
    es.emit("done", {});
    expect(es.closed).toBe(true);

    subscribeToJob("job-2", {});
    last().emit("error", { code: "SOURCE_BLOCKED", message: "x" });
    expect(last().closed).toBe(true);
  });

  it("ignores unnamed messages", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    last().emit("message", PROGRESS);
    expect(Object.values(h).every((fn) => fn.mock.calls.length === 0)).toBe(
      true,
    );
  });

  it("clamps pct to 0..100 and nulls a missing or invalid pct", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const es = last();
    es.emit("progress", { stage: "fetching", pct: 140 });
    es.emit("progress", { stage: "fetching", pct: -3 });
    es.emit("progress", { stage: "fetching" });
    es.emit("progress", { stage: "fetching", pct: "50" });
    expect(h.onProgress.mock.calls.map(([e]) => e.pct)).toEqual([
      100,
      0,
      null,
      null,
    ]);
  });

  it.each([
    ["non-JSON", "not json"],
    ["a JSON array", "[]"],
    ["an unknown stage", { stage: "uploading", pct: 1 }],
    ["a missing stage", { pct: 1 }],
  ])("drops a progress event with %s", (_label, data) => {
    const h = spies();
    subscribeToJob("job-1", h);
    last().emit("progress", data);
    expect(h.onProgress).not.toHaveBeenCalled();
  });

  it("drops events whose data isn't a string", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const es = last();
    es.dispatchEvent(new MessageEvent("progress", { data: 42 }));
    es.dispatchEvent(new MessageEvent("audio_ready", { data: AUDIO }));
    es.dispatchEvent(new MessageEvent("key_ready", { data: null }));
    expect(h.onProgress).not.toHaveBeenCalled();
    expect(h.onAudioReady).not.toHaveBeenCalled();
    expect(h.onKeyReady).not.toHaveBeenCalled();
  });

  it("drops an audio_ready without track_id or audio_url", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const es = last();
    es.emit("audio_ready", { ...AUDIO, audio_url: null });
    es.emit("audio_ready", { ...AUDIO, track_id: 7 });
    es.emit("audio_ready", "nope");
    expect(h.onAudioReady).not.toHaveBeenCalled();
    // …and still accepts a valid one afterwards.
    es.emit("audio_ready", AUDIO);
    expect(h.onAudioReady).toHaveBeenCalledWith(AUDIO);
  });

  it("defaults a missing title or duration rather than blocking playback", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    last().emit("audio_ready", { track_id: "t", audio_url: "/media/x.m4a" });
    expect(h.onAudioReady).toHaveBeenCalledWith({
      track_id: "t",
      audio_url: "/media/x.m4a",
      duration_s: 0,
      title: "",
    });
  });

  it.each([
    ["non-JSON", "{"],
    ["a flat tonic", { ...KEY, tonic: "Bb" }],
    ["an unknown mode", { ...KEY, mode: "dorian" }],
  ])("drops a key_ready with %s", (_label, data) => {
    const h = spies();
    subscribeToJob("job-1", h);
    last().emit("key_ready", data);
    expect(h.onKeyReady).not.toHaveBeenCalled();
  });

  it("sanitizes key_ready alternates, confidence and tuning", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    last().emit("key_ready", {
      tonic: "A#",
      mode: "minor",
      alternates: [
        { tonic: "C#", mode: "major", confidence: 0.5 },
        { tonic: "Db", mode: "major", confidence: 0.4 },
        "junk",
        { tonic: "F", mode: "minor" },
      ],
      tuning_cents: "x",
    });
    expect(h.onKeyReady).toHaveBeenCalledWith({
      tonic: "A#",
      mode: "minor",
      confidence: 0,
      alternates: [
        { tonic: "C#", mode: "major", confidence: 0.5 },
        { tonic: "F", mode: "minor", confidence: 0 },
      ],
      tuning_cents: 0,
    });
  });

  it("treats non-array alternates as none", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    last().emit("key_ready", { ...KEY, alternates: null });
    expect(h.onKeyReady).toHaveBeenCalledWith({ ...KEY, alternates: [] });
  });
});

describe("subscribeToJob: server errors", () => {
  it.each([
    "SOURCE_BLOCKED",
    "SOURCE_UNAVAILABLE",
    "VIDEO_TOO_LONG",
    "LIVESTREAM",
    "UNSUPPORTED_FILE",
    "NOT_FOUND",
    "INTERNAL",
  ] as const)("closes on fatal %s, then calls onError once", (code) => {
    const h = spies();
    let closedDuringOnError = false;
    subscribeToJob("job-1", {
      ...h,
      onError: (e) => {
        closedDuringOnError = last().closed;
        h.onError(e);
      },
    });
    const es = last();
    es.emit("progress", PROGRESS);
    es.emit("error", { code, message: "blocked" });
    expect(h.onError).toHaveBeenCalledWith({ code, message: "blocked" });
    expect(closedDuringOnError).toBe(true);
    expect(es.closed).toBe(true);
    // Nothing more is delivered, and there's no onDone after a fatal error.
    es.emit("error", { code, message: "again" });
    es.emit("done", {});
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onConnectionError).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("KEY_DETECTION_FAILED is non-fatal: onError, then waits for done", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const es = last();
    es.emit("audio_ready", AUDIO);
    es.emit("error", { code: "KEY_DETECTION_FAILED", message: "no key" });
    expect(h.onError).toHaveBeenCalledWith({
      code: "KEY_DETECTION_FAILED",
      message: "no key",
    });
    expect(es.closed).toBe(false);
    expect(h.onDone).not.toHaveBeenCalled();
    es.emit("done", {});
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(es.closed).toBe(true);
  });

  it.each([
    ["an unknown code", { code: "NEW_CODE", message: "m" }, "m"],
    ["a missing code", { message: "m" }, "m"],
    ["a missing message", { code: "NEW_CODE" }, ""],
    ["non-JSON data", "oops", ""],
    ["a JSON array", "[]", ""],
  ])("delivers an error with %s as fatal INTERNAL", (_label, data, message) => {
    const h = spies();
    subscribeToJob("job-1", h);
    last().emit("error", data);
    expect(h.onError).toHaveBeenCalledWith({ code: "INTERNAL", message });
    expect(last().closed).toBe(true);
  });
});

describe("subscribeToJob: replay on reconnect", () => {
  it("delivers audio_ready, key_ready and KEY_DETECTION_FAILED at most once; progress may repeat", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const es = last();
    es.open();
    es.emit("progress", { stage: "processing", pct: null });
    es.emit("audio_ready", AUDIO);
    es.emit("progress", { stage: "analyzing", pct: null });
    es.emit("error", { code: "KEY_DETECTION_FAILED", message: "x" });

    // The connection drops; the browser reconnects and the server replays state.
    es.fail(FakeEventSource.CONNECTING);
    es.open();
    es.emit("progress", { stage: "analyzing", pct: null });
    es.emit("audio_ready", { ...AUDIO, title: "replayed" });
    es.emit("error", { code: "KEY_DETECTION_FAILED", message: "x" });
    es.emit("done", {});

    expect(h.onProgress).toHaveBeenCalledTimes(3);
    expect(h.onAudioReady).toHaveBeenCalledTimes(1);
    expect(h.onAudioReady).toHaveBeenCalledWith(AUDIO);
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onConnectionError).not.toHaveBeenCalled();
  });

  it("delivers key_ready at most once across a manual reconnect", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const first = last();
    first.open();
    first.emit("audio_ready", AUDIO);
    first.emit("key_ready", KEY);
    first.fail(FakeEventSource.CLOSED);
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);

    const second = last();
    expect(second).not.toBe(first);
    second.open();
    second.emit("audio_ready", AUDIO);
    second.emit("key_ready", KEY);
    second.emit("done", {});
    expect(h.onAudioReady).toHaveBeenCalledTimes(1);
    expect(h.onKeyReady).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("drops a duplicate key_ready on the same connection", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    last().emit("key_ready", KEY);
    last().emit("key_ready", KEY);
    expect(h.onKeyReady).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeToJob: transport failures", () => {
  it(`lets the browser retry, and gives up after ${String(MAX_CONSECUTIVE_FAILURES)} consecutive failures`, () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(5);
    const h = spies();
    subscribeToJob("job-1", h);
    const es = last();
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      es.fail(FakeEventSource.CONNECTING);
      expect(h.onConnectionError).not.toHaveBeenCalled();
      expect(es.closed).toBe(false);
    }
    es.fail(FakeEventSource.CONNECTING);
    expect(h.onConnectionError).toHaveBeenCalledTimes(1);
    expect(es.closed).toBe(true);
    // The browser-driven retries never needed a second EventSource.
    expect(FakeEventSource.instances).toHaveLength(1);
    // Nothing else fires afterwards.
    es.fail();
    es.emit("done", {});
    expect(h.onConnectionError).toHaveBeenCalledTimes(1);
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it("resets the failure count on every successful open", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const es = last();
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) es.fail();
      es.open();
    }
    expect(h.onConnectionError).not.toHaveBeenCalled();
    expect(es.closed).toBe(false);
  });

  it("reconnects itself with backoff when the browser gives up (readyState CLOSED)", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const expectedDelays = [1000, 2000, 4000, 8000];
    expect(RECONNECT_BASE_DELAY_MS).toBe(1000);
    expect(RECONNECT_MAX_DELAY_MS).toBe(8000);

    for (const [i, delay] of expectedDelays.entries()) {
      const es = last();
      es.fail(FakeEventSource.CLOSED);
      expect(es.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(i + 1);
      vi.advanceTimersByTime(delay - 1);
      expect(FakeEventSource.instances).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(i + 2);
      expect(last().url).toBe("/api/jobs/job-1/events");
    }

    expect(h.onConnectionError).not.toHaveBeenCalled();
    last().fail(FakeEventSource.CLOSED); // 5th consecutive failure
    expect(h.onConnectionError).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(expectedDelays.length + 1);
  });

  it("mixes browser retries and manual reconnects in one failure count", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    last().fail(FakeEventSource.CONNECTING); // 1
    last().fail(FakeEventSource.CLOSED); // 2 → manual reconnect in 2 s
    vi.advanceTimersByTime(2000);
    last().fail(FakeEventSource.CONNECTING); // 3
    last().fail(FakeEventSource.CONNECTING); // 4
    expect(h.onConnectionError).not.toHaveBeenCalled();
    last().fail(FakeEventSource.CONNECTING); // 5
    expect(h.onConnectionError).toHaveBeenCalledTimes(1);
  });

  it("ignores events from a replaced EventSource", () => {
    const h = spies();
    subscribeToJob("job-1", h);
    const first = last();
    first.fail(FakeEventSource.CLOSED);
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS);
    first.emit("audio_ready", AUDIO);
    first.fail();
    first.open();
    expect(h.onAudioReady).not.toHaveBeenCalled();
    last().emit("audio_ready", AUDIO);
    expect(h.onAudioReady).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeToJob: unsubscribe", () => {
  it("closes the stream, and no handler fires afterwards", () => {
    const h = spies();
    const unsubscribe = subscribeToJob("job-1", h);
    const es = last();
    es.open();
    unsubscribe();
    expect(es.closed).toBe(true);

    es.emit("progress", PROGRESS);
    es.emit("audio_ready", AUDIO);
    es.emit("key_ready", KEY);
    es.emit("error", { code: "SOURCE_BLOCKED", message: "x" });
    es.emit("error", { code: "KEY_DETECTION_FAILED", message: "x" });
    es.emit("done", {});
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 1; i++) es.fail();
    expect(Object.values(h).every((fn) => fn.mock.calls.length === 0)).toBe(
      true,
    );
  });

  it("cancels a pending reconnect", () => {
    const h = spies();
    const unsubscribe = subscribeToJob("job-1", h);
    last().fail(FakeEventSource.CLOSED);
    unsubscribe();
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(h.onConnectionError).not.toHaveBeenCalled();
  });

  it("is idempotent, including after done", () => {
    const h = spies();
    const unsubscribe = subscribeToJob("job-1", h);
    last().emit("done", {});
    unsubscribe();
    unsubscribe();
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("can be called from inside a handler", () => {
    const h = spies();
    const unsubscribe = subscribeToJob("job-1", {
      ...h,
      onAudioReady: (e) => {
        h.onAudioReady(e);
        unsubscribe();
      },
    });
    const es = last();
    es.emit("audio_ready", AUDIO);
    es.emit("key_ready", KEY);
    expect(es.closed).toBe(true);
    expect(h.onKeyReady).not.toHaveBeenCalled();
  });
});
