// 16-bit PCM stereo WAV encoder (§10 B5). Pure TS, no Web Audio needed.

export const WAV_HEADER_BYTES = 44;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BLOCK_ALIGN = CHANNELS * BYTES_PER_SAMPLE;

/** Float sample (-1..1) to int16. Clips out-of-range values; NaN becomes silence. */
export function floatToInt16(sample: number): number {
  if (Number.isNaN(sample)) return 0;
  const clipped = Math.max(-1, Math.min(1, sample));
  // Asymmetric scale so -1 maps to -32768 and +1 to +32767 exactly.
  return Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff);
}

/**
 * Encodes channel data as a stereo 16-bit PCM WAV file. Mono input is
 * duplicated to both channels; only the first two channels of wider input are
 * kept. Every channel must have the same length as the first.
 */
export function encodeWavBytes(
  channels: readonly Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  const left = channels[0];
  if (!left) throw new RangeError("encodeWav: the buffer has no channels");
  // The header stores an integer rate; Web Audio rates are integers in practice.
  const rate = Math.round(sampleRate);
  if (!Number.isFinite(sampleRate) || rate <= 0) {
    throw new RangeError(
      `encodeWav: invalid sample rate ${String(sampleRate)}`,
    );
  }
  const right = channels[1] ?? left;
  if (right.length !== left.length) {
    throw new RangeError("encodeWav: channels have different lengths");
  }

  const frames = left.length;
  const dataBytes = frames * BLOCK_ALIGN;
  const out = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // RIFF chunk size: file size - 8
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format 1 = integer PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * BLOCK_ALIGN, true); // byte rate
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    view.setInt16(offset, floatToInt16(left[i] ?? 0), true);
    view.setInt16(offset + 2, floatToInt16(right[i] ?? 0), true);
    offset += BLOCK_ALIGN;
  }
  return out;
}

export function encodeWavBlob(buffer: AudioBuffer): Blob {
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(CHANNELS, buffer.numberOfChannels); c++) {
    channels.push(buffer.getChannelData(c));
  }
  return new Blob([encodeWavBytes(channels, buffer.sampleRate)], {
    type: "audio/wav",
  });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
