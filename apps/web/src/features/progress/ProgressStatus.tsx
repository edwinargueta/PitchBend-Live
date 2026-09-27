import { ProgressBar } from "../../components/ProgressBar";
import type { ProgressStage } from "../../lib/types";
import type { SessionPhase, SessionSource } from "../../hooks/sessionReducer";
import { describeProgress, type StepId } from "./describeProgress";
import "./progress.css";

interface ProgressStatusProps {
  phase: SessionPhase;
  source: SessionSource | null;
  uploadPct: number | null;
  stage: ProgressStage | null;
  pct: number | null;
  onCancel: () => void;
}

const STEPS: { id: StepId; label: (upload: boolean) => string }[] = [
  { id: "fetch", label: (upload) => (upload ? "Upload" : "Fetch audio") },
  { id: "process", label: () => "Process" },
  { id: "play", label: () => "Ready to play" },
];

export function ProgressStatus({
  phase,
  source,
  uploadPct,
  stage,
  pct,
  onCancel,
}: ProgressStatusProps) {
  const view = describeProgress(phase, source, uploadPct, stage, pct);
  const current = STEPS.findIndex((s) => s.id === view.step);
  const upload = source === "upload";

  return (
    <section
      className="progress-status card"
      aria-labelledby="progress-heading"
    >
      <h2 id="progress-heading" className="sr-only">
        Progress
      </h2>
      <div className="progress-status__head">
        <p className="progress-status__label" role="status">
          {view.label}
        </p>
        {view.pct !== null && (
          <span className="progress-status__pct" aria-hidden="true">
            {Math.round(view.pct)}%
          </span>
        )}
      </div>
      <ProgressBar label={view.label} value={view.pct} />
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            className={
              i < current
                ? "steps__item is-done"
                : i === current
                  ? "steps__item is-current"
                  : "steps__item"
            }
            aria-current={i === current ? "step" : undefined}
          >
            {s.label(upload)}
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn--ghost" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}
