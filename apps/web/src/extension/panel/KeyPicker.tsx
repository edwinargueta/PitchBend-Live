// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Manual original key (FR-5): v1 has no key detection for YouTube, so the
// user says what key the song is in, and the readout follows the transpose.
import { useId, useState } from "react";
import {
  PITCH_CLASSES,
  isMode,
  isPitchClass,
  spellTonic,
  type Key,
} from "../../lib/music";
import type { Mode } from "../../lib/types";

interface KeyPickerProps {
  value: Key | null;
  onChange: (key: Key | null) => void;
}

export function KeyPicker({ value, onChange }: KeyPickerProps) {
  const tonicId = useId();
  const modeId = useId();
  const [draftMode, setDraftMode] = useState<Mode>("major");
  const mode = value?.mode ?? draftMode;

  return (
    <fieldset className="key-picker">
      <legend className="key-picker__legend">Original key</legend>
      <div className="key-picker__row">
        <label htmlFor={tonicId} className="sr-only">
          Tonic
        </label>
        <select
          id={tonicId}
          value={value?.tonic ?? ""}
          onChange={(e) => {
            const tonic = e.currentTarget.value;
            onChange(isPitchClass(tonic) ? { tonic, mode } : null);
          }}
        >
          <option value="">Not set</option>
          {PITCH_CLASSES.map((pc) => (
            <option key={pc} value={pc}>
              {spellTonic(pc, mode)}
            </option>
          ))}
        </select>
        <label htmlFor={modeId} className="sr-only">
          Mode
        </label>
        <select
          id={modeId}
          value={mode}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (!isMode(next)) return;
            setDraftMode(next);
            if (value) onChange({ tonic: value.tonic, mode: next });
          }}
        >
          <option value="major">major</option>
          <option value="minor">minor</option>
        </select>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={value === null}
          onClick={() => {
            onChange(null);
          }}
        >
          Clear
        </button>
      </div>
    </fieldset>
  );
}
