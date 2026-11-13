// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// The per-tab settings reducer (FR-2, FR-5, FR-6, FR-7, FR-8). Pure: every
// transpose request, whatever its source (panel, shortcut, restore), goes
// through normalizeSemitones here, so the range rule lives in one place (AC-5).
import { normalizeSemitones } from "../../audio/pitch";
import { isTabSettings, type Command, type TabSettings } from "./protocol";

export const DEFAULT_SETTINGS: TabSettings = {
  semitones: 0,
  bypass: false,
  key: null,
};

/** The settings after `cmd`. `getStatus` changes nothing. */
export function applyCommand(settings: TabSettings, cmd: Command): TabSettings {
  switch (cmd.type) {
    case "set":
      return { ...settings, semitones: normalizeSemitones(cmd.semitones) };
    case "nudge":
      return {
        ...settings,
        semitones: normalizeSemitones(settings.semitones + cmd.delta),
      };
    case "reset":
      return { ...settings, semitones: 0 };
    case "setBypass":
      return { ...settings, bypass: cmd.on };
    case "toggleBypass":
      return { ...settings, bypass: !settings.bypass };
    case "setKey":
      return { ...settings, key: cmd.key };
    case "getStatus":
      return settings;
  }
}

/**
 * A new video started in the tab (FR-6, AC-8): keep the transpose and bypass,
 * forget the original key so the readout never names the wrong key.
 */
export function onVideoChanged(settings: TabSettings): TabSettings {
  return settings.key === null ? settings : { ...settings, key: null };
}

/** Settings read back from storage: anything malformed becomes the defaults. */
export function parseSettings(value: unknown): TabSettings {
  if (!isTabSettings(value)) return DEFAULT_SETTINGS;
  return { ...value, semitones: normalizeSemitones(value.semitones) };
}

/**
 * Whether the tab needs the audio graph. Transposing does; so does bypass
 * when it was already attached (handled by the controller). At 0 with bypass
 * off, nothing is attached, so YouTube's audio is never touched needlessly.
 */
export function wantsShift(settings: TabSettings): boolean {
  return settings.semitones !== 0;
}
