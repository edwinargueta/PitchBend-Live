// Signal generation and analysis for the engine's browser tests. Runs in the
// page, so only small numbers cross back to the Playwright process.

export interface ToneSegment {
  start: number;
  end: number;
  freq: number;
  amp?: number;
}

export interface SignalSpec {
  seconds: number;
  sampleRate: number;
  channels: number;
  /** Tones to place on the timeline; silence elsewhere. */
  segments: ToneSegment[];
}

const EDGE_FADE_S = 0.005;

/** Sine segments with 5 ms raised-cosine edges (no clicks to smear the spectrum). */
export function makeSignal(spec: SignalSpec): Float32Array[] {
  const length = Math.round(spec.seconds * spec.sampleRate);
  const data = new Float32Array(length);
  for (const seg of spec.segments) {
    const amp = seg.amp ?? 0.5;
    const from = Math.max(0, Math.round(seg.start * spec.sampleRate));
    const to = Math.min(length, Math.round(seg.end * spec.sampleRate));
    const fade = EDGE_FADE_S * spec.sampleRate;
    for (let i = from; i < to; i++) {
      const edge = Math.min(i - from, to - 1 - i);
      const gain =
        edge < fade ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade) : 1;
      data[i] =
        (data[i] ?? 0) +
        amp * gain * Math.sin((2 * Math.PI * seg.freq * i) / spec.sampleRate);
    }
  }
  return Array.from({ length: spec.channels }, () => data.slice());
}

export function toAudioBuffer(
  channels: Float32Array[],
  sampleRate: number,
): AudioBuffer {
  const buffer = new AudioBuffer({
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    sampleRate,
  });
  channels.forEach((data, c) => {
    buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c);
  });
  return buffer;
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] ?? 0, re[i] ?? 0];
      [im[i], im[j]] = [im[j] ?? 0, im[i] ?? 0];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const a = start + k;
        const b = a + size / 2;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const tr = br * wr - bi * wi;
        const ti = br * wi + bi * wr;
        re[b] = (re[a] ?? 0) - tr;
        im[b] = (im[a] ?? 0) - ti;
        re[a] = (re[a] ?? 0) + tr;
        im[a] = (im[a] ?? 0) + ti;
      }
    }
  }
}

/**
 * Strongest frequency in channel 0 between `startS` and `endS`: Hann-windowed
 * FFT over the largest power-of-two span that fits, refined by parabolic
 * interpolation on the log magnitude.
 */
export function dominantFrequency(
  buffer: AudioBuffer,
  startS: number,
  endS: number,
): number {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const from = Math.round(startS * sr);
  const span = Math.min(data.length - from, Math.round((endS - startS) * sr));
  const n = 2 ** Math.floor(Math.log2(span));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = (data[from + i] ?? 0) * w;
  }
  fft(re, im);
  const mag = (k: number): number =>
    Math.log(Math.hypot(re[k] ?? 0, im[k] ?? 0) + 1e-12);
  let peak = 1;
  for (let k = 2; k < n / 2; k++) {
    if (mag(k) > mag(peak)) peak = k;
  }
  const a = mag(peak - 1);
  const b = mag(peak);
  const c = mag(peak + 1);
  const offset = (0.5 * (a - c)) / (a - 2 * b + c);
  return ((peak + offset) * sr) / n;
}

export interface Burst {
  onset: number;
  offset: number;
}

/**
 * Where the sound is on and off: 5 ms RMS windows every 1 ms, split at half
 * the loudest window's level, with linear interpolation at each crossing.
 */
export function bursts(buffer: AudioBuffer): Burst[] {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const win = Math.round(0.005 * sr);
  const hop = Math.round(0.001 * sr);
  const levels: number[] = [];
  for (let start = 0; start + win <= data.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + win; i++) sum += (data[i] ?? 0) ** 2;
    levels.push(Math.sqrt(sum / win));
  }
  let loudest = 0;
  for (const level of levels) loudest = Math.max(loudest, level); // no spread: long inputs
  const threshold = loudest / 2;
  const timeOf = (index: number): number => (index * hop + win / 2) / sr;
  const cross = (i: number): number => {
    const a = levels[i - 1] ?? 0;
    const b = levels[i] ?? 0;
    const frac = b === a ? 0 : (threshold - a) / (b - a);
    return timeOf(i - 1 + frac);
  };
  const found: Burst[] = [];
  let onset: number | null = null;
  for (let i = 1; i < levels.length; i++) {
    const was = (levels[i - 1] ?? 0) >= threshold;
    const is = (levels[i] ?? 0) >= threshold;
    if (!was && is) onset = cross(i);
    if (was && !is && onset !== null) {
      found.push({ onset, offset: cross(i) });
      onset = null;
    }
  }
  return found;
}
