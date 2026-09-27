import { describe, expect, it } from "vitest";
import type { Track } from "../lib/types";
import {
  initialSessionState,
  isBusy,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "./sessionReducer";

const KEY = {
  tonic: "G" as const,
  mode: "major" as const,
  confidence: 0.82,
  alternates: [],
  tuning_cents: -12,
};

const AUDIO = {
  track_id: "t1",
  audio_url: "/media/a.m4a",
  duration_s: 200,
  title: "Song",
};

const TRACK: Track = {
  track_id: "t1",
  source: "upload",
  title: "Song",
  duration_s: 200,
  status: "ready",
  audio_url: "/media/a.m4a",
  key: null,
  expires_at: "2026-09-27T00:00:00Z",
};

function run(...actions: SessionAction[]): SessionState {
  return actions.reduce(sessionReducer, initialSessionState);
}

const submitUrl: SessionAction = { type: "submit", source: "url" };
const queued: SessionAction = {
  type: "jobCreated",
  job: { job_id: "j1", track_id: "t1", status: "queued" },
};

describe("sessionReducer", () => {
  it("starts idle and not busy", () => {
    expect(initialSessionState.phase).toBe("idle");
    expect(isBusy(initialSessionState)).toBe(false);
  });

  it("submit → submitting, with upload progress only for uploads", () => {
    expect(run(submitUrl)).toMatchObject({
      phase: "submitting",
      source: "url",
      uploadPct: null,
    });
    const upload = run({ type: "submit", source: "upload" });
    expect(upload.uploadPct).toBe(0);
    expect(isBusy(upload)).toBe(true);
  });

  it("tracks and clamps upload progress while submitting only", () => {
    const s = run(
      { type: "submit", source: "upload" },
      { type: "uploadProgress", pct: 140 },
    );
    expect(s.uploadPct).toBe(100);
    expect(
      sessionReducer(initialSessionState, { type: "uploadProgress", pct: 5 }),
    ).toBe(initialSessionState);
  });

  it("202 → waiting in the queued stage", () => {
    const s = run(submitUrl, queued);
    expect(s).toMatchObject({
      phase: "waiting",
      stage: "queued",
      jobId: "j1",
      trackId: "t1",
    });
    expect(isBusy(s)).toBe(true);
  });

  it("200 done → waiting with no stage (the client reads the track next)", () => {
    const s = run(submitUrl, {
      type: "jobCreated",
      job: { job_id: "j1", track_id: "t1", status: "done" },
    });
    expect(s).toMatchObject({ phase: "waiting", stage: null });
  });

  it("ignores jobCreated unless submitting", () => {
    expect(sessionReducer(initialSessionState, queued)).toBe(
      initialSessionState,
    );
  });

  it("follows named progress stages and clamps pct", () => {
    let s = run(submitUrl, queued, {
      type: "progress",
      event: { stage: "fetching", pct: 42 },
    });
    expect(s).toMatchObject({ stage: "fetching", pct: 42 });
    s = sessionReducer(s, {
      type: "progress",
      event: { stage: "processing", pct: null },
    });
    expect(s).toMatchObject({ stage: "processing", pct: null });
    s = sessionReducer(s, {
      type: "progress",
      event: { stage: "processing", pct: -3 },
    });
    expect(s.pct).toBe(0);
  });

  it("ignores progress when idle or failed", () => {
    expect(
      sessionReducer(initialSessionState, {
        type: "progress",
        event: { stage: "fetching", pct: 1 },
      }),
    ).toBe(initialSessionState);
  });

  it("audio_ready makes the player usable before the key is known", () => {
    const s = run(submitUrl, queued, { type: "audioReady", event: AUDIO });
    expect(s.phase).toBe("ready");
    expect(s.track).toEqual({
      trackId: "t1",
      audioUrl: "/media/a.m4a",
      title: "Song",
      durationS: 200,
    });
    expect(s.key).toEqual({ status: "pending", info: null });
    expect(isBusy(s)).toBe(false);
  });

  it("ignores audio_ready unless waiting or ready", () => {
    expect(
      sessionReducer(initialSessionState, { type: "audioReady", event: AUDIO }),
    ).toBe(initialSessionState);
  });

  it("keeps a known key when audio_ready is replayed", () => {
    const s = run(
      submitUrl,
      queued,
      { type: "audioReady", event: AUDIO },
      { type: "keyReady", key: KEY },
      { type: "audioReady", event: AUDIO },
    );
    expect(s.key).toEqual({ status: "ready", info: KEY });
  });

  it("analyzing progress after audio_ready is tracked", () => {
    const s = run(
      submitUrl,
      queued,
      { type: "audioReady", event: AUDIO },
      { type: "progress", event: { stage: "analyzing", pct: null } },
    );
    expect(s).toMatchObject({ phase: "ready", stage: "analyzing" });
  });

  it("key_ready fills the key; done keeps it", () => {
    const s = run(
      submitUrl,
      queued,
      { type: "audioReady", event: AUDIO },
      { type: "keyReady", key: KEY },
      { type: "done" },
    );
    expect(s.key).toEqual({ status: "ready", info: KEY });
    expect(s.done).toBe(true);
  });

  it("ignores key_ready and done when idle", () => {
    expect(
      sessionReducer(initialSessionState, { type: "keyReady", key: KEY }),
    ).toBe(initialSessionState);
    expect(sessionReducer(initialSessionState, { type: "done" })).toBe(
      initialSessionState,
    );
  });

  it("KEY_DETECTION_FAILED is non-fatal: key unknown, still playable", () => {
    const s = run(
      submitUrl,
      queued,
      { type: "audioReady", event: AUDIO },
      {
        type: "jobError",
        error: { code: "KEY_DETECTION_FAILED", message: "x" },
      },
      { type: "done" },
    );
    expect(s.phase).toBe("ready");
    expect(s.key).toEqual({ status: "failed", info: null });
    expect(s.error).toBeNull();
  });

  it("KEY_DETECTION_FAILED doesn't clobber a key that already arrived", () => {
    const s = run(
      submitUrl,
      queued,
      { type: "audioReady", event: AUDIO },
      { type: "keyReady", key: KEY },
      {
        type: "jobError",
        error: { code: "KEY_DETECTION_FAILED", message: "x" },
      },
    );
    expect(s.key.status).toBe("ready");
  });

  it("done without a key means the key is unknown", () => {
    const s = run(
      submitUrl,
      queued,
      { type: "audioReady", event: AUDIO },
      { type: "done" },
    );
    expect(s.key).toEqual({ status: "failed", info: null });
  });

  it("a fatal error before audio → error phase", () => {
    const s = run(submitUrl, queued, {
      type: "jobError",
      error: { code: "SOURCE_BLOCKED", message: "blocked" },
    });
    expect(s.phase).toBe("error");
    expect(s.error).toEqual({ code: "SOURCE_BLOCKED", message: "blocked" });
    expect(isBusy(s)).toBe(false);
  });

  it("a fatal error after audio only costs the key", () => {
    const s = run(
      submitUrl,
      queued,
      { type: "audioReady", event: AUDIO },
      {
        type: "jobError",
        error: { code: "INTERNAL", message: "boom" },
      },
    );
    expect(s.phase).toBe("ready");
    expect(s.key.status).toBe("failed");
    expect(s.done).toBe(true);
  });

  it("ignores job errors when idle", () => {
    expect(
      sessionReducer(initialSessionState, {
        type: "jobError",
        error: { code: "INTERNAL", message: "x" },
      }),
    ).toBe(initialSessionState);
  });

  it("request failures → error phase, with retry_after_s kept", () => {
    const s = run(submitUrl, {
      type: "failed",
      error: { code: "RATE_LIMITED", message: "slow down", retryAfterS: 30 },
    });
    expect(s).toMatchObject({
      phase: "error",
      error: { code: "RATE_LIMITED", retryAfterS: 30 },
      stage: null,
    });
  });

  it("a failure after audio never tears the player down", () => {
    const ready = run(submitUrl, queued, { type: "audioReady", event: AUDIO });
    const failed: SessionAction = {
      type: "failed",
      error: { code: "INTERNAL", message: "x" },
    };
    const s = sessionReducer(ready, failed);
    expect(s.phase).toBe("ready");
    expect(s.key.status).toBe("failed");
    const withKey = sessionReducer(ready, { type: "keyReady", key: KEY });
    expect(sessionReducer(withKey, failed)).toBe(withKey);
  });

  it("ignores failures when idle", () => {
    expect(
      sessionReducer(initialSessionState, {
        type: "failed",
        error: { code: "INTERNAL", message: "x" },
      }),
    ).toBe(initialSessionState);
  });

  it("trackLoaded (cache hit) → ready, with the key when present", () => {
    const hit = run(submitUrl, {
      type: "jobCreated",
      job: { job_id: "j1", track_id: "t1", status: "done" },
    });
    const noKey = sessionReducer(hit, { type: "trackLoaded", track: TRACK });
    expect(noKey.phase).toBe("ready");
    expect(noKey.key.status).toBe("pending");
    const withKey = sessionReducer(hit, {
      type: "trackLoaded",
      track: { ...TRACK, key: KEY },
    });
    expect(withKey.key).toEqual({ status: "ready", info: KEY });
  });

  it("ignores trackLoaded without audio or outside waiting/ready", () => {
    const hit = run(submitUrl, queued);
    expect(
      sessionReducer(hit, {
        type: "trackLoaded",
        track: { ...TRACK, audio_url: null },
      }),
    ).toBe(hit);
    expect(
      sessionReducer(initialSessionState, {
        type: "trackLoaded",
        track: TRACK,
      }),
    ).toBe(initialSessionState);
  });

  it("reset → idle", () => {
    const s = run(submitUrl, queued, { type: "reset" });
    expect(s).toEqual(initialSessionState);
  });

  it("a new submission clears the previous track", () => {
    const s = run(
      submitUrl,
      queued,
      { type: "audioReady", event: AUDIO },
      { type: "submit", source: "upload" },
    );
    expect(s).toMatchObject({
      phase: "submitting",
      track: null,
      source: "upload",
    });
  });
});
