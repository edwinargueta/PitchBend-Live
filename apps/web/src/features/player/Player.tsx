import { useId, type CSSProperties } from "react";
import type { EngineError } from "../../audio/errors";
import { Icon } from "../../components/Icon";
import { ProgressBar } from "../../components/ProgressBar";
import type { EngineStatus } from "../../hooks/useAudioEngine";
import { describeEngineError } from "./engineErrorCopy";
import { formatTime, spokenTime } from "./time";
import { Waveform } from "./Waveform";
import "./player.css";

interface PlayerProps {
  /** Untrusted: rendered as text only. */
  title: string;
  status: EngineStatus;
  loadPct: number | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  audioBuffer: AudioBuffer | null;
  /**
   * The engine failure to explain. Shown with status "error" (the track can't
   * play) and also with "ready" for a `playback` error, where Play still works.
   */
  error: EngineError | null;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  /** Reload the same track in a fresh engine (retryable kinds only). */
  onRetry: () => void;
  onStartOver: () => void;
}

/** §10 C3: play/pause, seek bar with time, and the waveform. */
export function Player({
  title,
  status,
  loadPct,
  isPlaying,
  currentTime,
  duration,
  audioBuffer,
  error,
  onToggle,
  onSeek,
  onRetry,
  onStartOver,
}: PlayerProps) {
  const titleId = useId();
  const seekId = useId();
  const failure =
    error !== null || status === "error" ? describeEngineError(error) : null;
  const ready = status === "ready";
  const max = duration > 0 ? duration : 0;
  const time = Math.min(Math.max(0, currentTime), max);
  const pct = max > 0 ? (time / max) * 100 : 0;

  return (
    <section className="player card" aria-labelledby={titleId}>
      <p className="eyebrow">Now playing</p>
      <h2 id={titleId} className="player__title">
        {title}
      </h2>

      {status === "loading" && (
        <div className="player__loading">
          <p role="status">Loading audio…</p>
          <ProgressBar label="Loading audio" value={loadPct} />
        </div>
      )}
      {failure && (
        <div className="player__error">
          <div role="alert">
            <p className="player__error-title">{failure.title}</p>
            <p>{failure.message}</p>
          </div>
          <details className="player__details">
            <summary>Technical details</summary>
            <pre>{failure.details}</pre>
          </details>
          <div className="player__actions">
            {failure.retryable && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={onRetry}
              >
                Try again
              </button>
            )}
            <button type="button" className="btn" onClick={onStartOver}>
              Start over
            </button>
          </div>
        </div>
      )}

      <div className="player__wave">
        {audioBuffer ? (
          <Waveform buffer={audioBuffer} currentTime={time} onSeek={onSeek} />
        ) : (
          <div className="waveform waveform--placeholder" aria-hidden="true" />
        )}
      </div>

      <div className="player__controls">
        <button
          type="button"
          className="play-btn"
          onClick={onToggle}
          disabled={!ready}
          aria-label={isPlaying ? "Pause" : "Play"}
          aria-keyshortcuts="Space"
        >
          <Icon name={isPlaying ? "pause" : "play"} size={28} />
        </button>
        <div className="seek">
          <label htmlFor={seekId} className="sr-only">
            Seek
          </label>
          <input
            id={seekId}
            className="seek__input"
            type="range"
            min={0}
            max={max}
            step={0.1}
            value={time}
            disabled={!ready}
            onChange={(e) => {
              onSeek(Number(e.currentTarget.value));
            }}
            aria-valuetext={`${spokenTime(time)} of ${spokenTime(max)}`}
            style={{ "--seek-pct": `${pct.toFixed(2)}%` } as CSSProperties}
          />
          <div className="seek__times">
            <span>{formatTime(time)}</span>
            <span>{formatTime(max)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
