// Friendly copy for every §6.6 error code (§10 C7). Implemented by the web-lib workstream.
import type { ErrorCode } from "./types";

export interface ErrorCopy {
  title: string;
  message: string;
  /** SOURCE_BLOCKED (and similar) must prominently suggest uploading the file instead. */
  suggestUpload: boolean;
}

/**
 * Mirrors §6.2 (MAX_DURATION_S, MAX_UPLOAD_MB, MEDIA_TTL_HOURS). Display copy only:
 * the server enforces the real limits. Change these together with §6.2.
 */
export const LIMITS = {
  maxDurationS: 720,
  maxUploadMb: 50,
  mediaTtlHours: 24,
} as const;

/** Every §6.6 code, for validating codes that arrive over the wire. */
export const ERROR_CODES: readonly ErrorCode[] = [
  "INVALID_URL",
  "UNSUPPORTED_FILE",
  "FILE_TOO_LARGE",
  "VIDEO_TOO_LONG",
  "LIVESTREAM",
  "SOURCE_UNAVAILABLE",
  "SOURCE_BLOCKED",
  "RATE_LIMITED",
  "KEY_DETECTION_FAILED",
  "NOT_FOUND",
  "INTERNAL",
];

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === "string" &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * How long to wait, for RATE_LIMITED copy: "45 seconds", "1 minute", "3 minutes".
 * Rounds up (never tells people to retry too early). Unknown or invalid → "a few minutes".
 */
export function formatWait(retryAfterS?: number): string {
  if (
    retryAfterS === undefined ||
    !Number.isFinite(retryAfterS) ||
    retryAfterS < 0
  ) {
    return "a few minutes";
  }
  const seconds = Math.max(1, Math.ceil(retryAfterS));
  if (seconds < 60) return plural(seconds, "second");
  return plural(Math.ceil(seconds / 60), "minute");
}

/** 720 → "12 minutes"; 750 → "12 minutes 30 seconds". Never rounds (it describes limits). */
export function formatLength(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return plural(rest, "second");
  if (rest === 0) return plural(minutes, "minute");
  return `${plural(minutes, "minute")} ${plural(rest, "second")}`;
}

export function describeError(
  code: ErrorCode,
  retryAfterS?: number,
): ErrorCopy {
  switch (code) {
    case "INVALID_URL":
      return {
        title: "That’s not a YouTube video link",
        message:
          "Paste a link to a single YouTube video (a youtube.com/watch, youtu.be or Shorts link). Playlists, channels and live pages aren’t supported.",
        suggestUpload: false,
      };
    case "UNSUPPORTED_FILE":
      return {
        title: "That file isn’t supported",
        message:
          "Choose an audio file, such as MP3, WAV, M4A/AAC, FLAC or Ogg/Opus.",
        suggestUpload: false,
      };
    case "FILE_TOO_LARGE":
      return {
        title: "That file is too large",
        message: `Files can be up to ${String(LIMITS.maxUploadMb)} MB. Try a shorter or more compressed version, such as an MP3 or M4A.`,
        suggestUpload: false,
      };
    case "VIDEO_TOO_LONG":
      return {
        title: "That song is too long",
        message: `Songs can be up to ${formatLength(LIMITS.maxDurationS)} long. Try a shorter song, or trim the audio and upload that.`,
        suggestUpload: false,
      };
    case "LIVESTREAM":
      return {
        title: "Live streams aren’t supported",
        message:
          "Try again after the stream has ended, or upload the audio file instead.",
        suggestUpload: true,
      };
    case "SOURCE_UNAVAILABLE":
      return {
        title: "This video isn’t available",
        message:
          "It may be private, removed, or blocked in our server’s region. If you have the audio file, try uploading it instead.",
        suggestUpload: true,
      };
    case "SOURCE_BLOCKED":
      return {
        title: "Couldn’t get this video from YouTube",
        message:
          "YouTube blocked this request — try uploading the file instead. Uploads work just as well and don’t depend on YouTube.",
        suggestUpload: true,
      };
    case "RATE_LIMITED":
      return {
        title: "Too many requests",
        message: `You’ve loaded a lot of songs in a short time. Please wait ${formatWait(retryAfterS)} and try again.`,
        suggestUpload: false,
      };
    case "KEY_DETECTION_FAILED":
      return {
        title: "Couldn’t detect the key",
        message:
          "You can still play and transpose the song — the original key just won’t be shown.",
        suggestUpload: false,
      };
    case "NOT_FOUND":
      return {
        title: "Song not found",
        message: `It may have expired — songs are kept for ${String(LIMITS.mediaTtlHours)} hours. Paste the link or upload the file again.`,
        suggestUpload: false,
      };
    case "INTERNAL":
    default:
      // `default` also catches codes a newer server might send.
      return {
        title: "Something went wrong",
        message:
          "An unexpected error occurred. Check your connection and try again in a moment.",
        suggestUpload: false,
      };
  }
}

// ---- internals ---------------------------------------------------------------

function plural(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? "" : "s"}`;
}
