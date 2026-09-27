// §10 C5: "Original: G major (82%)" with tap-to-switch between the detected
// alternates, a live "Now: A major (+2)", the capo hint, and the tuning offset
// with an auto-correct toggle.
import { useId } from "react";
import { Skeleton } from "../../components/Skeleton";
import type { KeyState } from "../../hooks/sessionReducer";
import {
  capoHint,
  formatKey,
  formatSemitones,
  transposeKey,
} from "../../lib/music";
import type { KeyCandidate } from "../../lib/types";
import { formatCents } from "./cents";
import "./key-readout.css";

interface KeyReadoutProps {
  keyState: KeyState;
  semitones: number;
  /** Index into [detected key, ...alternates]: the basis for display. */
  basisIndex: number;
  onBasisChange: (index: number) => void;
  autoTune: boolean;
  onAutoTuneChange: (on: boolean) => void;
}

const percent = (c: KeyCandidate) =>
  `${String(Math.round(c.confidence * 100))}%`;

export function KeyReadout({
  keyState,
  semitones,
  basisIndex,
  onBasisChange,
  autoTune,
  onAutoTuneChange,
}: KeyReadoutProps) {
  const headingId = useId();
  const tuningHintId = useId();
  const info = keyState.status === "ready" ? keyState.info : null;
  const candidates: KeyCandidate[] = info ? [info, ...info.alternates] : [];
  const basis = candidates[basisIndex] ?? candidates[0] ?? null;
  const shift = formatSemitones(semitones);
  const now = basis
    ? `${formatKey(transposeKey(basis.tonic, basis.mode, semitones))} (${shift})`
    : shift;
  const capo = capoHint(semitones);

  return (
    <section className="key-readout card" aria-labelledby={headingId}>
      <h2 id={headingId} className="card__title">
        Key
      </h2>

      <div aria-live="polite">
        <p className="key-line">
          <span className="key-line__label">Original:</span>{" "}
          {keyState.status === "pending" && <Skeleton label="Analyzing key…" />}
          {keyState.status === "failed" && <strong>Key unknown</strong>}
          {basis && (
            <strong>
              {formatKey(basis)} ({percent(basis)})
            </strong>
          )}
        </p>
      </div>
      {keyState.status === "failed" && (
        <p className="hint">
          We couldn’t detect the key, but playback and transposing still work.
        </p>
      )}

      <p className="key-line key-line--now">
        <span className="key-line__label">Now:</span> <strong>{now}</strong>
      </p>
      {capo && <p className="hint">{capo}</p>}

      {candidates.length > 1 && (
        <div
          className="key-choices"
          role="group"
          aria-label="Detected key: tap to switch"
        >
          <span className="key-choices__label" aria-hidden="true">
            Not right? Tap to switch:
          </span>
          {candidates.map((c, i) => (
            <button
              key={`${c.tonic}-${c.mode}`}
              type="button"
              className="chip"
              aria-pressed={basis === c}
              onClick={() => {
                onBasisChange(i);
              }}
            >
              {formatKey(c)} <span className="chip__meta">{percent(c)}</span>
            </button>
          ))}
        </div>
      )}

      {info && (
        <div className="tuning">
          <p className="key-line">
            <span className="key-line__label">Tuning:</span>{" "}
            <strong>{formatCents(info.tuning_cents)}</strong>
          </p>
          {info.tuning_cents !== 0 && (
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                checked={autoTune}
                onChange={(e) => {
                  onAutoTuneChange(e.currentTarget.checked);
                }}
                aria-describedby={tuningHintId}
              />
              <span>Auto-correct tuning</span>
            </label>
          )}
          {info.tuning_cents !== 0 && (
            <p id={tuningHintId} className="hint">
              Shifts the song by {formatCents(-info.tuning_cents)} so it matches
              standard A440 tuning.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
