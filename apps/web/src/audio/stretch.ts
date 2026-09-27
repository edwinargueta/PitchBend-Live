import type { StretchFactory } from "signalsmith-stretch";

/** Stereo out. The processor reuses channel 0 for channel 1 when fed mono. */
export const STRETCH_CHANNELS = 2;

/**
 * AudioWorkletNode options for the stretch node. `numberOfInputs` must stay 1:
 * the processor reads `inputs[c % inputs.length]` while inactive and would
 * throw with no input at all; with nothing connected the input is empty, which
 * selects buffer playback (a connected input would switch it to live mode).
 */
export function stretchOptions(
  channels = STRETCH_CHANNELS,
): AudioWorkletNodeOptions {
  return {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
  };
}

/**
 * Tightly sized copies of the first (up to) two channels, ready to transfer
 * to the worklet. Copies keep the caller's AudioBuffer intact (transferring
 * its own channel data would detach it), and transferring the copies moves
 * them without a second clone.
 */
export function copyChannels(buffer: AudioBuffer): Float32Array<ArrayBuffer>[] {
  const out: Float32Array<ArrayBuffer>[] = [];
  const count = Math.min(STRETCH_CHANNELS, buffer.numberOfChannels);
  for (let c = 0; c < count; c++) {
    out.push(buffer.getChannelData(c).slice());
  }
  return out;
}

export function transferList(
  channels: readonly Float32Array<ArrayBuffer>[],
): ArrayBuffer[] {
  return channels.map((c) => c.buffer);
}

/** Loads the (large, WASM-carrying) library on first use, in its own chunk. */
export async function loadStretchFactory(): Promise<StretchFactory> {
  const mod = await import("signalsmith-stretch");
  return mod.default;
}
