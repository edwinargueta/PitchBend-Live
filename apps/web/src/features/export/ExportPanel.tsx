// §10 C6: "Download WAV" → engine.renderOffline → encodeWav → download, with
// render progress. Runs entirely in the browser (Phase 1 has no server export).
import { useEffect, useId, useRef, useState } from "react";
import type { AudioEngine } from "../../audio";
import { Icon } from "../../components/Icon";
import { ProgressBar } from "../../components/ProgressBar";
import { loadAudioModule } from "../../hooks/audioModule";
import { downloadBlob } from "./download";
import { exportFilename } from "./filename";
import "./export.css";

interface ExportPanelProps {
  /** Null until the audio is loaded. */
  engine: AudioEngine | null;
  title: string | null;
  semitones: number;
  cents: number;
  /** The shifted key for the filename, e.g. "Bb major"; null when unknown. */
  newKeyAscii: string | null;
  /** e.g. "G major → A major (+2)"; null when the key is unknown. */
  summary: string | null;
}

type ExportState =
  | { status: "idle" }
  | { status: "rendering"; pct: number | null }
  | { status: "done"; filename: string }
  | { status: "error" };

export function ExportPanel({
  engine,
  title,
  semitones,
  cents,
  newKeyAscii,
  summary,
}: ExportPanelProps) {
  const headingId = useId();
  const [state, setState] = useState<ExportState>({ status: "idle" });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const rendering = state.status === "rendering";

  const run = async () => {
    if (!engine || rendering) return;
    const filename = exportFilename(title, semitones, newKeyAscii);
    setState({ status: "rendering", pct: null });
    try {
      const buffer = await engine.renderOffline({
        semitones,
        cents,
        onProgress: (pct) => {
          if (aliveRef.current) setState({ status: "rendering", pct });
        },
      });
      const { encodeWav } = await loadAudioModule();
      const blob = encodeWav(buffer);
      if (!aliveRef.current) return;
      downloadBlob(blob, filename);
      setState({ status: "done", filename });
    } catch {
      if (aliveRef.current) setState({ status: "error" });
    }
  };

  return (
    <section className="export card" aria-labelledby={headingId}>
      <h2 id={headingId} className="card__title">
        Download
      </h2>
      {summary && <p className="export__summary">{summary}</p>}
      <button
        type="button"
        className="btn btn--primary btn--large"
        onClick={() => {
          void run();
        }}
        disabled={!engine || rendering}
      >
        <Icon name="download" />
        {rendering ? "Rendering…" : "Download WAV"}
      </button>

      <div role="status" className="export__status">
        {rendering && "Rendering your WAV file…"}
        {state.status === "done" && <>Saved “{state.filename}”.</>}
      </div>
      {state.status === "rendering" && (
        <div className="export__progress">
          <ProgressBar label="Rendering WAV" value={state.pct} />
          {state.pct !== null && (
            <span className="export__pct" aria-hidden="true">
              {Math.round(state.pct)}%
            </span>
          )}
        </div>
      )}
      {state.status === "error" && (
        <p className="field-error" role="alert">
          The export failed. Please try again.
        </p>
      )}
      <p className="hint">
        Rendered on your device. WAV files are large (about 10 MB per minute).
      </p>
    </section>
  );
}
