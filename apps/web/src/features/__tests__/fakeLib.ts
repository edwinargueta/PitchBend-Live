// Deterministic stand-ins for src/lib (owned and tested by the web-lib
// workstream). UI tests mock the lib with these so they only test the UI.
import { vi } from "vitest";
import type { JobEventHandlers } from "../../lib/sse";
import type {
  ErrorCode,
  JobCreated,
  Mode,
  PitchClass,
  Track,
} from "../../lib/types";

// ---- music ---------------------------------------------------------------------

interface Key {
  tonic: PitchClass;
  mode: Mode;
}

const NAMES: PitchClass[] = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

export const fakeMusic = {
  transposeKey(tonic: PitchClass, mode: Mode, semitones: number): Key {
    const i = NAMES.indexOf(tonic);
    return { tonic: NAMES[(((i + semitones) % 12) + 12) % 12] ?? "C", mode };
  },
  spellTonic: (tonic: PitchClass) => tonic,
  formatKey(key: Key, style: "display" | "spoken" | "ascii" = "display") {
    if (style === "spoken")
      return `${key.tonic.replace("#", " sharp")} ${key.mode}`;
    if (style === "ascii") return `${key.tonic} ${key.mode}`;
    return `${key.tonic.replace("#", "♯")} ${key.mode}`;
  },
  formatSemitones: (n: number) =>
    n > 0 ? `+${String(n)}` : n < 0 ? `−${String(-n)}` : "0",
  formatTransposition(from: Key, n: number) {
    const to = fakeMusic.transposeKey(from.tonic, from.mode, n);
    return `${fakeMusic.formatKey(from)} → ${fakeMusic.formatKey(to)} (${fakeMusic.formatSemitones(n)})`;
  },
  capoHint: (n: number) => (n === 0 ? null : `Capo hint for ${String(n)}`),
};

// ---- errors ----------------------------------------------------------------------

export const fakeErrors = {
  LIMITS: { maxDurationS: 720, maxUploadMb: 50, mediaTtlHours: 24 },
  describeError: (code: ErrorCode, retryAfterS?: number) => ({
    title: `Title ${code}`,
    message:
      retryAfterS === undefined
        ? `Message ${code}`
        : `Message ${code} ${String(retryAfterS)}`,
    suggestUpload: code === "SOURCE_BLOCKED",
  }),
};

// ---- youtube ---------------------------------------------------------------------

export const fakeYoutube = {
  extractVideoId: (input: string) =>
    /(?:[?&]v=|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(input)?.[1] ?? null,
};

// ---- api -------------------------------------------------------------------------

export class FakeApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
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

export function makeFakeApi() {
  return {
    ApiError: FakeApiError,
    createJob:
      vi.fn<
        (url: string, init?: { signal?: AbortSignal }) => Promise<JobCreated>
      >(),
    uploadFile:
      vi.fn<
        (
          file: File,
          opts?: { onProgress?: (pct: number) => void; signal?: AbortSignal },
        ) => Promise<JobCreated>
      >(),
    getTrack:
      vi.fn<
        (trackId: string, init?: { signal?: AbortSignal }) => Promise<Track>
      >(),
  };
}

// ---- sse -------------------------------------------------------------------------

export function makeFakeSse() {
  const subscriptions: {
    jobId: string;
    handlers: JobEventHandlers;
    unsubscribe: ReturnType<typeof vi.fn>;
  }[] = [];
  const subscribeToJob = vi.fn((jobId: string, handlers: JobEventHandlers) => {
    const unsubscribe = vi.fn();
    subscriptions.push({ jobId, handlers, unsubscribe });
    return unsubscribe;
  });
  return {
    subscribeToJob,
    subscriptions,
    /** The most recent subscription's handlers. */
    last() {
      const sub = subscriptions.at(-1);
      if (!sub) throw new Error("no subscription");
      return sub;
    },
  };
}

// ---- fixtures ----------------------------------------------------------------------

export const JOB_QUEUED: JobCreated = {
  job_id: "job-1",
  track_id: "trk-1",
  status: "queued",
};
export const JOB_DONE: JobCreated = {
  job_id: "job-1",
  track_id: "trk-1",
  status: "done",
};

export const KEY_G = {
  tonic: "G" as PitchClass,
  mode: "major" as Mode,
  confidence: 0.82,
  alternates: [
    { tonic: "E" as PitchClass, mode: "minor" as Mode, confidence: 0.71 },
    { tonic: "C" as PitchClass, mode: "major" as Mode, confidence: 0.4 },
  ],
  tuning_cents: -12,
};

export function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    track_id: "trk-1",
    source: "youtube",
    title: "My Song",
    duration_s: 180,
    status: "ready",
    audio_url: "/media/abc.m4a",
    key: KEY_G,
    expires_at: "2026-09-27T12:00:00Z",
    ...overrides,
  };
}

export const AUDIO_READY = {
  track_id: "trk-1",
  audio_url: "/media/abc.m4a",
  duration_s: 180,
  title: "My Song",
};
