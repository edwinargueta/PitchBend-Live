// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Messages between the side panel, the service worker and the content script.
// Every message crosses a process boundary, so each receiver validates it with
// the guards below before acting on it (spec: Security, input validation).
import { isMode, isPitchClass, type Key } from "../../lib/music";

/** Where the content script runs. */
export type Site = "youtube" | "music";

/**
 * The content script's attach state:
 * - `idle`: nothing attached yet (transpose 0, bypass off) or detached.
 * - `no-video`: the page has no main video right now.
 * - `waiting-gesture`: autoplay policy: the AudioContext can't start until the
 *   user clicks or presses a key on the page. Audio is untouched meanwhile.
 * - `starting`: dry path connected, the pitch shifter is loading.
 * - `active`: the pitch shifter is running.
 * - `error`: the shifter couldn't start; audio plays unmodified.
 */
export type AttachState =
  "idle" | "no-video" | "waiting-gesture" | "starting" | "active" | "error";

export const ATTACH_STATES: readonly AttachState[] = [
  "idle",
  "no-video",
  "waiting-gesture",
  "starting",
  "active",
  "error",
];

/** The per-tab settings (spec FR-7), kept in memory only. */
export interface TabSettings {
  readonly semitones: number;
  readonly bypass: boolean;
  readonly key: Key | null;
}

/** `sentAt` is `performance.timeOrigin + performance.now()` at the sender (AC-2). */
interface Timed {
  readonly sentAt?: number;
}

export type Command =
  | (Timed & { readonly type: "set"; readonly semitones: number })
  | (Timed & { readonly type: "nudge"; readonly delta: number })
  | (Timed & { readonly type: "reset" })
  | (Timed & { readonly type: "setBypass"; readonly on: boolean })
  | (Timed & { readonly type: "toggleBypass" })
  | (Timed & { readonly type: "setKey"; readonly key: Key | null })
  | { readonly type: "getStatus" };

export type CommandType = Command["type"];

export interface TabStatus {
  readonly state: AttachState;
  readonly settings: TabSettings;
  readonly site: Site | null;
  /** The pitch shifter's own latency, once it's running. */
  readonly shifterMs: number | null;
  /** Shifter latency + AudioContext.baseLatency: the delay behind the video (AC-3). */
  readonly addedMs: number | null;
  /** Human-readable reason for `error` (and for a refused attach). */
  readonly error: string | null;
  /** When the last pitch change reached the shifter (same clock as `sentAt`). */
  readonly appliedAt: number | null;
  /** The `sentAt` of the command that produced `appliedAt`, if it had one. */
  readonly sentAt: number | null;
}

/** Content script → extension pages: the tab's status changed. */
export interface StatusMessage {
  readonly type: "status";
  readonly status: TabStatus;
}

/** Content script → service worker on start-up: "what were this tab's settings?" */
export interface RestoreRequest {
  readonly type: "restoreRequest";
}

type Shape = Record<string, unknown>;

function isShape(value: unknown): value is Shape {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalFinite(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function nullableFinite(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

export function isKey(value: unknown): value is Key {
  return isShape(value) && isPitchClass(value.tonic) && isMode(value.mode);
}

export function isTabSettings(value: unknown): value is TabSettings {
  return (
    isShape(value) &&
    isFiniteNumber(value.semitones) &&
    typeof value.bypass === "boolean" &&
    (value.key === null || isKey(value.key))
  );
}

export function isCommand(value: unknown): value is Command {
  if (!isShape(value) || !optionalFinite(value.sentAt)) return false;
  switch (value.type) {
    case "set":
      return isFiniteNumber(value.semitones);
    case "nudge":
      return isFiniteNumber(value.delta);
    case "setBypass":
      return typeof value.on === "boolean";
    case "setKey":
      return value.key === null || isKey(value.key);
    case "reset":
    case "toggleBypass":
    case "getStatus":
      return true;
    default:
      return false;
  }
}

function isSite(value: unknown): value is Site | null {
  return value === null || value === "youtube" || value === "music";
}

export function isTabStatus(value: unknown): value is TabStatus {
  return (
    isShape(value) &&
    (ATTACH_STATES as readonly unknown[]).includes(value.state) &&
    isTabSettings(value.settings) &&
    isSite(value.site) &&
    nullableFinite(value.shifterMs) &&
    nullableFinite(value.addedMs) &&
    (value.error === null || typeof value.error === "string") &&
    nullableFinite(value.appliedAt) &&
    nullableFinite(value.sentAt)
  );
}

export function isStatusMessage(value: unknown): value is StatusMessage {
  return isShape(value) && value.type === "status" && isTabStatus(value.status);
}

export function isRestoreRequest(value: unknown): value is RestoreRequest {
  return isShape(value) && value.type === "restoreRequest";
}

/** A wall-clock timestamp comparable across extension documents (AC-2). */
export function preciseNow(
  perf: Pick<Performance, "timeOrigin" | "now"> = performance,
): number {
  return perf.timeOrigin + perf.now();
}
