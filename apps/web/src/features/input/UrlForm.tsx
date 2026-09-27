import { useId, useState, type ClipboardEvent, type SubmitEvent } from "react";
import { extractVideoId } from "../../lib/youtube";

interface UrlFormProps {
  onSubmit: (url: string) => void;
  busy: boolean;
}

const EMPTY_ERROR = "Paste a YouTube link first.";
const INVALID_ERROR =
  "That doesn't look like a YouTube video link. Try a youtube.com/watch or youtu.be link.";

/** One field for a YouTube URL (§10 C1); pasting a valid link submits right away. */
export function UrlForm({ onSubmit, busy }: UrlFormProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  const trySubmit = (raw: string) => {
    const url = raw.trim();
    if (url === "") {
      setError(EMPTY_ERROR);
      return;
    }
    // Client-side check only; the server re-validates and rebuilds the URL (§6.4).
    if (extractVideoId(url) === null) {
      setError(INVALID_ERROR);
      return;
    }
    setError(null);
    onSubmit(url);
  };

  const handleSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    trySubmit(value);
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").trim();
    if (pasted === "" || extractVideoId(pasted) === null) return; // normal paste
    e.preventDefault();
    setValue(pasted);
    setError(null);
    onSubmit(pasted);
  };

  return (
    <form className="url-form" onSubmit={handleSubmit} noValidate>
      <label className="field-label" htmlFor={inputId}>
        YouTube link
      </label>
      <div className="url-form__row">
        <input
          id={inputId}
          className="text-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://www.youtube.com/watch?v=…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onPaste={handlePaste}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errorId} ${hintId}` : hintId}
        />
        <button
          type="submit"
          className="btn btn--primary"
          aria-busy={busy || undefined}
        >
          Load
        </button>
      </div>
      <p id={hintId} className="hint">
        Paste a link and it starts loading right away.
      </p>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
