// Waveform peaks from the engine's decoded buffer (§10 C3: no second download).

/** Channel data as the waveform needs it; a structural subset of AudioBuffer. */
export interface PeakSource {
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * One mono peak (max |sample| across channels) per bucket, in 0..1.
 * One pass over the buffer; a 4-minute stereo song takes a few tens of ms.
 */
export function computePeaks(
  source: PeakSource,
  buckets: number,
): Float32Array {
  const count = Math.max(0, Math.min(Math.floor(buckets), source.length));
  const peaks = new Float32Array(count);
  if (count === 0) return peaks;
  const size = source.length / count;
  for (let c = 0; c < source.numberOfChannels; c++) {
    const data = source.getChannelData(c);
    for (let b = 0; b < count; b++) {
      const start = Math.floor(b * size);
      const end = Math.min(data.length, Math.floor((b + 1) * size));
      let max = peaks[b] ?? 0;
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i] ?? 0);
        if (v > max) max = v;
      }
      peaks[b] = Math.min(1, max);
    }
  }
  return peaks;
}
