// Cause-specific, actionable copy for audio-engine failures (§1 goal 4). The
// engine classifies each failure (EngineError.kind, audio/errors.ts); this maps
// it to what the person should do next.
import type { EngineError } from "../../audio/errors";

export interface EngineErrorCopy {
  title: string;
  message: string;
  /** Offer "Try again": a fresh engine loading the same URL. */
  retryable: boolean;
  /** Plain text for the "Technical details" disclosure (rendered as text only). */
  details: string;
}

const OPEN_ELSEWHERE = "Open this page in Chrome, Safari or Firefox.";

/**
 * Electron apps (VS Code's built-in browser and other webviews) and VS Code
 * itself. Used only to strengthen the hint, never to block anything.
 */
export function isEmbeddedBrowser(userAgent: string): boolean {
  return /Electron\//.test(userAgent) || /\bCode\//.test(userAgent);
}

function browserProblem(
  error: EngineError | null,
  embedded: boolean,
): Pick<EngineErrorCopy, "title" | "message"> {
  let reason = "It’s missing Web Audio features PitchBend Live needs.";
  if (error?.hint === "no-aac") {
    reason = "It can’t decode AAC audio, the format PitchBend Live plays.";
  } else if (error?.hint === "no-wasm") {
    reason =
      "It blocks WebAssembly, which PitchBend Live’s pitch shifter needs — often because of a security setting or a work policy.";
  }
  const advice = embedded
    ? `This looks like an embedded browser (such as VS Code’s built-in one), and those lack the AAC decoder or block WebAssembly. ${OPEN_ELSEWHERE}`
    : `Embedded browsers like VS Code’s built-in browser lack the AAC decoder or block WebAssembly. ${OPEN_ELSEWHERE}`;
  return {
    title: "This browser can’t play PitchBend Live audio",
    message: `${reason} ${advice}`,
  };
}

function headline(
  error: EngineError | null,
  embedded: boolean,
): Omit<EngineErrorCopy, "details"> {
  switch (error?.kind) {
    case "unsupported":
      return { ...browserProblem(error, embedded), retryable: false };
    case "decode":
      if (error.hint === "no-aac") {
        return { ...browserProblem(error, embedded), retryable: false };
      }
      return {
        title: "We couldn’t decode this audio",
        message:
          "The file may be damaged, or this browser can’t read its format. Try another song or file.",
        retryable: false,
      };
    case "network":
      return {
        title: "Couldn’t download the audio",
        message: "Check your internet connection, then try again.",
        retryable: true,
      };
    case "processor":
      return {
        title: "The audio processor stopped",
        message:
          "Something went wrong inside the browser’s audio engine. Try again to reload the song.",
        retryable: true,
      };
    case "playback":
      return {
        title: "The browser blocked playback",
        message: "Press Play again to start the audio.",
        retryable: true,
      };
    case undefined:
      return {
        title: "We couldn’t play this audio",
        message:
          "Something went wrong in the browser’s audio engine. Try again, or open this page in Chrome, Safari or Firefox.",
        retryable: true,
      };
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/** Kind, message, the cause chain and the browser: what a bug report needs. */
export function technicalDetails(
  error: EngineError | null,
  userAgent: string,
): string {
  const lines: string[] = [];
  if (error) {
    lines.push(
      `Kind: ${error.kind}${error.hint ? ` (${error.hint})` : ""}`,
      `Error: ${error.message}`,
    );
    let cause: unknown = error.cause;
    for (let depth = 0; cause != null && depth < 3; depth++) {
      lines.push(`Cause: ${describeCause(cause)}`);
      cause = cause instanceof Error ? cause.cause : undefined;
    }
  } else {
    lines.push("Error: unknown");
  }
  lines.push(`Browser: ${userAgent || "unknown"}`);
  return lines.join("\n");
}

export function describeEngineError(
  error: EngineError | null,
  userAgent: string = navigator.userAgent,
): EngineErrorCopy {
  return {
    ...headline(error, isEmbeddedBrowser(userAgent)),
    details: technicalDetails(error, userAgent),
  };
}
