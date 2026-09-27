// Waveform drawn by wavesurfer.js v8 from the engine's decoded AudioBuffer
// (peaks + duration), never from a second download (§10 C3). Wavesurfer gets no
// URL, so its internal <audio> has no source and can't play: the AudioEngine is
// the only thing that makes sound. Clicks/drags on the waveform seek the engine.
import { useEffect, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import { computePeaks } from "./peaks";
import { readWaveColors } from "./waveColors";

interface WaveformProps {
  buffer: AudioBuffer;
  currentTime: number;
  onSeek: (seconds: number) => void;
}

/** Enough resolution for wide screens; bars are thinned by barWidth/barGap. */
const PEAK_BUCKETS = 1600;

export function Waveform({ buffer, currentTime, onSeek }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const draggingRef = useRef(false);
  const timeRef = useRef(currentTime);
  const onSeekRef = useRef(onSeek);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onSeekRef.current = onSeek;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let ws: WaveSurfer | null = null;
    let offScheme: (() => void) | undefined;
    const duration = buffer.duration;

    import("wavesurfer.js")
      .then(({ default: WaveSurferCtor }) => {
        if (cancelled) return;
        const instance = WaveSurferCtor.create({
          container,
          peaks: [computePeaks(buffer, PEAK_BUCKETS)],
          duration,
          height: 72,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          cursorWidth: 2,
          normalize: true,
          interact: true,
          dragToSeek: true,
          autoplay: false,
          mediaControls: false,
          hideScrollbar: true,
          ...readWaveColors(container),
        });
        ws = instance;
        instance.setMuted(true); // belt and braces: it has no source anyway

        instance.on("ready", () => {
          wsRef.current = instance;
          instance.setTime(timeRef.current);
        });
        // A click (drags suppress the trailing click).
        instance.on("interaction", (newTime) => {
          if (!draggingRef.current) onSeekRef.current(newTime);
        });
        instance.on("dragstart", () => {
          draggingRef.current = true;
        });
        instance.on("dragend", (relativeX) => {
          draggingRef.current = false;
          onSeekRef.current(relativeX * duration);
        });
        instance.on("error", () => {
          if (!cancelled) setFailed(true);
        });

        // Follow light/dark switches while the page is open.
        if (!("matchMedia" in window)) return;
        const scheme = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => {
          instance.setOptions(readWaveColors(container));
        };
        scheme.addEventListener("change", onChange);
        offScheme = () => {
          scheme.removeEventListener("change", onChange);
        };
      })
      .catch(() => {
        // Decorative only: the seek bar still works without the waveform.
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      offScheme?.();
      ws?.destroy();
      wsRef.current = null;
      draggingRef.current = false;
    };
  }, [buffer]);

  useEffect(() => {
    timeRef.current = currentTime;
    if (!draggingRef.current) wsRef.current?.setTime(currentTime);
  }, [currentTime]);

  return (
    <div
      ref={containerRef}
      className={failed ? "waveform waveform--failed" : "waveform"}
      // The seek slider is the accessible equivalent of this pointer-only control.
      aria-hidden="true"
      data-testid="waveform"
    />
  );
}
