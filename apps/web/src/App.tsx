import { lazy, Suspense, useEffect, useRef } from "react";
import { ErrorPanel } from "./features/errors/ErrorPanel";
import { InputScreen } from "./features/input/InputScreen";
import type { UploadHandle } from "./features/input/UploadDropzone";
import { ProgressStatus } from "./features/progress/ProgressStatus";
import { loadAudioModule } from "./hooks/audioModule";
import { isBusy } from "./hooks/sessionReducer";
import { useTrackSession } from "./hooks/useTrackSession";
import { LIMITS } from "./lib/errors";

// The player screen (and, through it, the audio engine and wavesurfer) is a
// separate chunk, never part of the input screen's bundle. It's prefetched once
// the user has chosen a song, while the server fetches it.
const loadWorkspace = () => import("./features/workspace/TrackWorkspace");
const TrackWorkspace = lazy(loadWorkspace);

function WorkspaceFallback() {
  return (
    <section className="card workspace-fallback" aria-busy="true">
      <p role="status">Loading the player…</p>
    </section>
  );
}

export default function App() {
  const { state, submitUrl, submitFile, retry, canRetry, reset } =
    useTrackSession();
  const uploadRef = useRef<UploadHandle>(null);
  const track = state.phase === "ready" ? state.track : null;
  const error = state.phase === "error" ? state.error : null;
  const busy = isBusy(state);

  // Warm the player and the audio engine during the server's work, so the song
  // starts sooner on audio_ready. Failures surface later, when they're used.
  useEffect(() => {
    if (!busy) return;
    loadWorkspace().catch(() => undefined);
    loadAudioModule().catch(() => undefined);
  }, [busy]);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">PitchBend Live</h1>
        {!track && (
          <p className="tagline">
            Transpose any song to your key, live, without changing the tempo.
          </p>
        )}
      </header>

      <main className="app-main">
        {track ? (
          <Suspense fallback={<WorkspaceFallback />}>
            <TrackWorkspace
              key={track.trackId}
              track={track}
              keyState={state.key}
              onStartOver={reset}
            />
          </Suspense>
        ) : (
          <>
            {error && (
              <ErrorPanel
                error={error}
                onUploadInstead={() => uploadRef.current?.open()}
                onRetry={canRetry ? retry : undefined}
                onStartOver={reset}
              />
            )}
            <InputScreen
              uploadRef={uploadRef}
              onSubmitUrl={submitUrl}
              onSubmitFile={submitFile}
              busy={busy}
              highlightUpload={error?.code === "SOURCE_BLOCKED"}
            />
            {busy && (
              <ProgressStatus
                phase={state.phase}
                source={state.source}
                uploadPct={state.uploadPct}
                stage={state.stage}
                pct={state.pct}
                onCancel={reset}
              />
            )}
          </>
        )}
      </main>

      <footer className="app-footer">
        <p>
          For personal practice only. Songs are deleted after{" "}
          {LIMITS.mediaTtlHours} hours and are never listed publicly.
        </p>
      </footer>
    </div>
  );
}
