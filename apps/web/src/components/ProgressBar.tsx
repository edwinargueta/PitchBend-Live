import "./components.css";

interface ProgressBarProps {
  /** Accessible name, e.g. "Upload progress". */
  label: string;
  /** 0..100, or null for an indeterminate bar. */
  value: number | null;
  className?: string;
}

export function ProgressBar({ label, value, className }: ProgressBarProps) {
  const pct =
    value === null ? null : Math.round(Math.min(100, Math.max(0, value)));
  return (
    <div
      className={[
        "progress",
        pct === null ? "progress--indeterminate" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={pct === null ? "In progress" : `${String(pct)}%`}
    >
      <div
        className="progress__fill"
        style={pct === null ? undefined : { width: `${String(pct)}%` }}
      />
    </div>
  );
}
