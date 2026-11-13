// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Side-panel wording (FR-3, FR-5, AC-10, AC-11). Pure, so every string is
// unit-tested; key spelling and capo rules come from src/lib/music.ts.
import { dialValueText } from "../../features/key-dial/dial";
import {
  capoHint,
  formatKey,
  formatSemitones,
  formatTransposition,
  transposeKey,
} from "../../lib/music";
import type { AttachState, TabSettings, TabStatus } from "../shared/protocol";

/** The key you hear now, or null when no original key is set. */
function nowKey(settings: TabSettings) {
  const { key, semitones } = settings;
  return key ? transposeKey(key.tonic, key.mode, semitones) : null;
}

/** "G major → A major (+2)" with a key; "+2" without one (AC-10). */
export function nowLine(settings: TabSettings): string {
  if (settings.key)
    return formatTransposition(settings.key, settings.semitones);
  return settings.semitones === 0
    ? "Original key"
    : formatSemitones(settings.semitones);
}

/** "Capo 2", or null when no practical capo position exists. */
export function capoLine(settings: TabSettings): string | null {
  return capoHint(settings.semitones);
}

/** aria-valuetext: "Plus 2 semitones, A major" (AC-11). */
export function dialText(settings: TabSettings): string {
  const key = nowKey(settings);
  return dialValueText(
    settings.semitones,
    key ? formatKey(key, "spoken") : null,
  );
}

/** The visible caption under the dial: the key you hear, if known. */
export function dialCaption(settings: TabSettings): string | null {
  const key = nowKey(settings);
  return key ? formatKey(key) : null;
}

export type Tone = "info" | "ok" | "warn" | "error";

const STATE_COPY: Readonly<Record<AttachState, { tone: Tone; text: string }>> =
  {
    idle: {
      tone: "info",
      text: "Ready. Move the dial to transpose this video.",
    },
    "no-video": { tone: "warn", text: "No video found on this page." },
    "waiting-gesture": {
      tone: "warn",
      text: "Click the video once to enable PitchBend Live.",
    },
    starting: { tone: "info", text: "Starting the pitch shifter…" },
    active: { tone: "ok", text: "Transposing this tab." },
    error: {
      tone: "error",
      text: "The pitch shifter couldn't start. The video plays without transposing.",
    },
  };

/** The status line for a tab (errors carry the content script's reason). */
export function statusCopy(status: TabStatus): { tone: Tone; text: string } {
  const copy = STATE_COPY[status.state];
  return status.state === "error" && status.error
    ? { tone: copy.tone, text: status.error }
    : copy;
}

/** "Audio delay: 70 ms" (AC-3), or null before anything is attached. */
export function delayLine(status: TabStatus): string | null {
  return status.addedMs === null
    ? null
    : `Audio delay behind the video: ${String(status.addedMs)} ms`;
}

/** The manifest's suggested shortcuts (AC-11); users can change them. */
export const SHORTCUT_HELP: readonly { keys: string; action: string }[] = [
  { keys: "Alt+Shift+↑", action: "Up one semitone" },
  { keys: "Alt+Shift+↓", action: "Down one semitone" },
  { keys: "Alt+Shift+0", action: "Back to the original key" },
  { keys: "Alt+Shift+B", action: "Bypass on/off" },
];
