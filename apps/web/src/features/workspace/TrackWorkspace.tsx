// The player screen, shown as soon as audio is ready — even before the key is
// known (§6.5, §10 C2). Lazy-loaded by App, so none of this (nor the audio
// engine or wavesurfer, which it imports dynamically) weighs on the input screen.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useAudioEngine } from "../../hooks/useAudioEngine";
import { useGlobalShortcuts } from "../../hooks/useGlobalShortcuts";
import type { KeyState, SessionTrack } from "../../hooks/sessionReducer";
import { formatKey, formatTransposition, transposeKey } from "../../lib/music";
import { ExportPanel } from "../export/ExportPanel";
import { clampSemitones, dialValueText } from "../key-dial/dial";
import { KeyDial } from "../key-dial/KeyDial";
import { KeyReadout } from "../key-readout/KeyReadout";
import { Player } from "../player/Player";
import "./workspace.css";

export interface TrackWorkspaceProps {
  track: SessionTrack;
  keyState: KeyState;
  onStartOver: () => void;
}

const clampCents = (n: number) => Math.min(50, Math.max(-50, Math.round(n)));

export default function TrackWorkspace({
  track,
  keyState,
  onStartOver,
}: TrackWorkspaceProps) {
  const player = useAudioEngine(track.audioUrl, track.durationS ?? 0);
  const { engine } = player;
  const [semitones, setSemitones] = useState(0);
  const [autoTune, setAutoTune] = useState(false);
  const [basisIndex, setBasisIndex] = useState(0);
  // What the engine should be playing; applied again when the engine becomes ready.
  const appliedRef = useRef({ semitones: 0, cents: 0 });

  const info = keyState.status === "ready" ? keyState.info : null;
  const candidates = info ? [info, ...info.alternates] : [];
  const basis = candidates[basisIndex] ?? candidates[0] ?? null;
  const tuningCents = info?.tuning_cents ?? 0;
  const cents = autoTune && info ? clampCents(-tuningCents) : 0;
  const newKey = basis
    ? transposeKey(basis.tonic, basis.mode, semitones)
    : null;
  const title = track.title?.trim() ? track.title : "Untitled";

  useEffect(() => {
    if (!engine) return;
    engine.setSemitones(appliedRef.current.semitones);
    engine.setCents(appliedRef.current.cents);
  }, [engine]);

  const changeSemitones = useCallback(
    (n: number) => {
      const next = clampSemitones(n);
      appliedRef.current.semitones = next;
      engine?.setSemitones(next); // live, client-side only (D1)
      setSemitones(next);
    },
    [engine],
  );

  const changeAutoTune = (on: boolean) => {
    const next = on && info ? clampCents(-tuningCents) : 0;
    appliedRef.current.cents = next;
    engine?.setCents(next);
    setAutoTune(on);
  };

  useGlobalShortcuts({
    onStep: (delta) => {
      // The ref is current even between rapid key repeats.
      changeSemitones(appliedRef.current.semitones + delta);
    },
    onReset: () => {
      changeSemitones(0);
    },
    onTogglePlay: player.toggle,
  });

  return (
    <div className="workspace">
      <div className="workspace__bar">
        <button type="button" className="btn btn--ghost" onClick={onStartOver}>
          <Icon name="back" />
          New song
        </button>
      </div>

      <Player
        title={title}
        status={player.status}
        loadPct={player.loadPct}
        isPlaying={player.isPlaying}
        currentTime={player.currentTime}
        duration={player.duration}
        audioBuffer={player.audioBuffer}
        error={player.error}
        onToggle={player.toggle}
        onSeek={player.seek}
        onRetry={player.retry}
        onStartOver={onStartOver}
      />

      <div className="workspace__grid">
        <section className="card dial-card" aria-label="Key dial">
          <KeyDial
            value={semitones}
            onChange={changeSemitones}
            valueText={dialValueText(
              semitones,
              newKey ? formatKey(newKey, "spoken") : null,
            )}
            caption={newKey ? formatKey(newKey) : null}
          />
        </section>
        <KeyReadout
          keyState={keyState}
          semitones={semitones}
          basisIndex={basisIndex}
          onBasisChange={setBasisIndex}
          autoTune={autoTune}
          onAutoTuneChange={changeAutoTune}
        />
      </div>

      <ExportPanel
        engine={engine}
        title={track.title}
        semitones={semitones}
        cents={cents}
        newKeyAscii={newKey ? formatKey(newKey, "ascii") : null}
        summary={basis ? formatTransposition(basis, semitones) : null}
      />

      <p className="hint workspace__shortcuts">
        Keyboard: <kbd>←</kbd> <kbd>→</kbd> change key · <kbd>0</kbd> reset ·{" "}
        <kbd>Space</kbd> play/pause
      </p>
    </div>
  );
}
