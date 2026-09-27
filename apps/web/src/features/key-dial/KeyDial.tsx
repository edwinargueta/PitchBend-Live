// The key dial (§10 C4, §7 accessibility): −12…+12, integer snapping, a large
// touch target, and a centre "reset to original" button. It's a real ARIA slider,
// operable by pointer (drag round the ring) and keyboard. Every change is passed
// straight up, where it goes to engine.setSemitones — live, no server call (D1).
import { useId, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { formatSemitones } from "../../lib/music";
import {
  MAX_SEMITONES,
  MIN_SEMITONES,
  SWEEP_DEG,
  arcPath,
  clampSemitones,
  pointToValue,
  polar,
  valueToAngle,
} from "./dial";
import "./key-dial.css";

interface KeyDialProps {
  value: number;
  onChange: (semitones: number) => void;
  /** aria-valuetext, e.g. "Plus 2 semitones, A major". */
  valueText: string;
  /** Visible caption under the value, e.g. "A major". */
  caption?: string | null;
}

const SIZE = 240;
const C = SIZE / 2;
const R = 100;
/** Ignore presses near the middle: that's the reset button. */
const DEAD_ZONE = 0.3;

const TICKS = Array.from(
  { length: MAX_SEMITONES - MIN_SEMITONES + 1 },
  (_, i) => MIN_SEMITONES + i,
);

export function KeyDial({ value, onChange, valueText, caption }: KeyDialProps) {
  const labelId = useId();
  const draggingRef = useRef(false);
  const current = clampSemitones(value);
  const angle = valueToAngle(current);
  const knob = polar(C, C, R, angle);

  const set = (n: number) => {
    const next = clampSemitones(n);
    if (next !== current) onChange(next);
  };

  const valueAt = (e: PointerEvent<HTMLDivElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const radius = Math.min(rect.width, rect.height) / 2;
    if (radius > 0 && Math.hypot(dx, dy) < radius * DEAD_ZONE) return null;
    return pointToValue(dx, dy);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const next = valueAt(e);
    if (next === null) return;
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    set(next);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const next = valueAt(e);
    // Don't jump across the dead gap at the bottom (+12 ↔ −12).
    if (next === null || Math.abs(next - current) > MAX_SEMITONES) return;
    set(next);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowUp: current + 1,
      ArrowLeft: current - 1,
      ArrowDown: current - 1,
      PageUp: current + 5,
      PageDown: current - 5,
      Home: MIN_SEMITONES,
      End: MAX_SEMITONES,
      "0": 0,
    };
    const next = steps[e.key];
    if (next === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    set(next);
  };

  return (
    <div className="key-dial">
      <p id={labelId} className="key-dial__label">
        Transpose
      </p>
      <div className="key-dial__ring">
        <div
          className="key-dial__dial"
          role="slider"
          tabIndex={0}
          aria-labelledby={labelId}
          aria-valuemin={MIN_SEMITONES}
          aria-valuemax={MAX_SEMITONES}
          aria-valuenow={current}
          aria-valuetext={valueText}
          aria-keyshortcuts="ArrowLeft ArrowRight 0"
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <svg
            viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`}
            aria-hidden="true"
          >
            <path
              className="key-dial__track"
              d={arcPath(C, C, R, -SWEEP_DEG, SWEEP_DEG)}
            />
            {current !== 0 && (
              <path
                className="key-dial__fill"
                d={arcPath(C, C, R, Math.min(0, angle), Math.max(0, angle))}
              />
            )}
            {TICKS.map((n) => {
              const major = n % 6 === 0;
              const a = valueToAngle(n);
              const p1 = polar(C, C, R - 16, a);
              const p2 = polar(C, C, R - (major ? 28 : 22), a);
              return (
                <line
                  key={n}
                  className={
                    major
                      ? "key-dial__tick key-dial__tick--major"
                      : "key-dial__tick"
                  }
                  x1={p1.x}
                  y1={p1.y}
                  x2={p2.x}
                  y2={p2.y}
                />
              );
            })}
            <text
              className="key-dial__end"
              x={polar(C, C, R, -SWEEP_DEG).x}
              y={SIZE - 6}
            >
              −12
            </text>
            <text
              className="key-dial__end"
              x={polar(C, C, R, SWEEP_DEG).x}
              y={SIZE - 6}
            >
              +12
            </text>
            <circle className="key-dial__knob" cx={knob.x} cy={knob.y} r={14} />
          </svg>
        </div>
        <button
          type="button"
          className="key-dial__reset"
          onClick={() => {
            set(0);
          }}
          disabled={current === 0}
          aria-label="Reset to original key"
          aria-keyshortcuts="0"
        >
          <span className="key-dial__value" aria-hidden="true">
            {formatSemitones(current)}
          </span>
          <span className="key-dial__reset-text">
            {current === 0 ? "Original" : "Reset"}
          </span>
        </button>
      </div>
      {caption && (
        <p className="key-dial__caption" aria-hidden="true">
          {caption}
        </p>
      )}
      <div className="key-dial__steppers">
        <button
          type="button"
          className="btn btn--round"
          onClick={() => {
            set(current - 1);
          }}
          disabled={current <= MIN_SEMITONES}
          aria-label="Down one semitone"
        >
          −
        </button>
        <button
          type="button"
          className="btn btn--round"
          onClick={() => {
            set(current + 1);
          }}
          disabled={current >= MAX_SEMITONES}
          aria-label="Up one semitone"
        >
          +
        </button>
      </div>
    </div>
  );
}
