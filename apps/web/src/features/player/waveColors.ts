import type { WaveSurferOptions } from "wavesurfer.js";

type WaveColors = Pick<
  WaveSurferOptions,
  "waveColor" | "progressColor" | "cursorColor"
>;

/** Canvas needs concrete colours, so read the themed CSS custom properties. */
export function readWaveColors(el: HTMLElement): WaveColors {
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    waveColor: pick("--wave", "#9ca3af"),
    progressColor: pick("--wave-progress", "#4338ca"),
    cursorColor: pick("--wave-cursor", "#4338ca"),
  };
}
