import type { StretchFactory, StretchNode } from "signalsmith-stretch";
import { noop, progressReporter } from "./progress";
import {
  copyChannels,
  STRETCH_CHANNELS,
  stretchOptions,
  transferList,
} from "./stretch";

/** Progress checkpoints per render (every 2.5%). */
export const RENDER_CHECKPOINTS = 40;
/** Web Audio renders in 128-frame quanta; suspend times snap to them. */
export const RENDER_QUANTUM = 128;

export interface RenderDeps {
  loadStretch(): Promise<StretchFactory>;
  createOfflineContext(
    channels: number,
    length: number,
    sampleRate: number,
  ): OfflineAudioContext;
}

/**
 * Renders `source` through the same stretch processor used for live playback,
 * in an OfflineAudioContext at the source's sample rate and exact length.
 * Tempo is 1.0 (input position == output time), so the result lines up with
 * the original sample for sample in time, only shifted in pitch.
 */
export async function renderStretched(
  deps: RenderDeps,
  source: AudioBuffer,
  semitones: number,
  onProgress?: (pct: number) => void,
): Promise<AudioBuffer> {
  const report = progressReporter(onProgress);
  report(0);
  const factory = await deps.loadStretch();
  const ctx = deps.createOfflineContext(
    STRETCH_CHANNELS,
    source.length,
    source.sampleRate,
  );
  const node = await factory(ctx, stretchOptions());
  node.connect(ctx.destination);
  const channels = copyChannels(source);
  await node.addBuffers(channels, transferList(channels));
  await node.schedule({
    output: 0,
    active: true,
    input: 0,
    rate: 1,
    semitones,
  });
  await watchProgress(ctx, node, source, report);
  const rendered = await ctx.startRendering();
  report(100);
  return rendered;
}

/** Frame offsets for progress checkpoints: quantum-aligned, unique, inside the render. */
export function checkpointFrames(
  length: number,
  count = RENDER_CHECKPOINTS,
): number[] {
  const frames = new Set<number>();
  for (let k = 1; k < count; k++) {
    const frame =
      Math.floor((length * k) / count / RENDER_QUANTUM) * RENDER_QUANTUM;
    if (frame > 0 && frame < length) frames.add(frame);
  }
  return [...frames];
}

function supportsSuspend(ctx: OfflineAudioContext): boolean {
  return typeof (ctx as { suspend?: unknown }).suspend === "function";
}

/**
 * Preferred: suspend()/resume() checkpoints, which report exactly how far the
 * render is. Fallback (no OfflineAudioContext.suspend): the processor's own
 * position messages, which arrive while it renders. Either way the value stays
 * below 100 until startRendering() resolves.
 */
async function watchProgress(
  ctx: OfflineAudioContext,
  node: StretchNode,
  source: AudioBuffer,
  report: (pct: number) => void,
): Promise<void> {
  const toPct = (fraction: number): number => Math.min(99, fraction * 100);
  if (supportsSuspend(ctx)) {
    for (const frame of checkpointFrames(source.length)) {
      ctx.suspend(frame / source.sampleRate).then(
        () => {
          report(toPct(frame / source.length)); // never throws
          ctx.resume().catch(noop);
        },
        noop, // A checkpoint the browser refuses just means one report fewer.
      );
    }
    return;
  }
  const interval = Math.max(0.05, source.duration / RENDER_CHECKPOINTS);
  await node.setUpdateInterval(interval, (inputTime) => {
    report(toPct(inputTime / source.duration));
  });
}
