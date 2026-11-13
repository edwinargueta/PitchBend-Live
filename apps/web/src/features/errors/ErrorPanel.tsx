import { useId } from "react";
import { Icon } from "../../components/Icon";
import { useCountdown } from "../../hooks/useCountdown";
import type { SessionError } from "../../hooks/sessionReducer";
import { describeError } from "../../lib/errors";
import type { ErrorCode } from "../../lib/types";
import { formatTime } from "../player/time";
import "./errors.css";

interface ErrorPanelProps {
  error: SessionError;
  /** Focus/open the upload control (SOURCE_BLOCKED and friends). */
  onUploadInstead: () => void;
  /** Re-submit the last input; omitted when there's nothing to retry. */
  onRetry?: () => void;
  onStartOver: () => void;
}

const RETRYABLE = new Set<ErrorCode>(["RATE_LIMITED", "INTERNAL"]);

/**
 * ADR 0009: the Chrome extension transposes the YouTube video in the page,
 * so YouTube's blocking of the server doesn't apply to it. Secondary to
 * uploading, which stays the primary action (CLAUDE.md §7).
 */
export const EXTENSION_HINT =
  "Watching in Chrome on a computer? The PitchBend Live Chrome extension transposes the YouTube video as it plays, with nothing to fetch.";

/** Every §6.6 code gets friendly, actionable copy (§1 goal 4, §10 C7). */
export function ErrorPanel({
  error,
  onUploadInstead,
  onRetry,
  onStartOver,
}: ErrorPanelProps) {
  const titleId = useId();
  const copy = describeError(error.code, error.retryAfterS);
  const suggestUpload = copy.suggestUpload || error.code === "SOURCE_BLOCKED";
  const remaining = useCountdown(
    error.code === "RATE_LIMITED" ? (error.retryAfterS ?? null) : null,
  );
  const canRetry = onRetry !== undefined && RETRYABLE.has(error.code);

  return (
    <section
      className={
        suggestUpload
          ? "error-panel card error-panel--upload"
          : "error-panel card"
      }
      aria-labelledby={titleId}
    >
      <div role="alert">
        <h2 id={titleId} className="error-panel__title">
          {copy.title}
        </h2>
        <p className="error-panel__message">{copy.message}</p>
      </div>
      <div className="error-panel__actions">
        {suggestUpload && (
          <button
            type="button"
            className="btn btn--primary btn--large"
            onClick={onUploadInstead}
          >
            <Icon name="upload" />
            Upload the file instead
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            className={suggestUpload ? "btn" : "btn btn--primary"}
            disabled={remaining > 0}
            onClick={onRetry}
          >
            {remaining > 0
              ? `Try again in ${formatTime(remaining)}`
              : "Try again"}
          </button>
        )}
        {error.code === "NOT_FOUND" && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onStartOver}
          >
            <Icon name="reset" />
            Start over
          </button>
        )}
      </div>
      {error.code === "SOURCE_BLOCKED" && (
        <p className="error-panel__hint">{EXTENSION_HINT}</p>
      )}
    </section>
  );
}
