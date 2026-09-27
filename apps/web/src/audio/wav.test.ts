// @vitest-environment node
import { describe, expect, it } from "vitest";
import { encodeWav } from "./index";
import { fakeAudioBuffer } from "./testing/fakes";
import { encodeWavBytes, floatToInt16, WAV_HEADER_BYTES } from "./wav";

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function samples(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  const out: number[] = [];
  for (let offset = WAV_HEADER_BYTES; offset < buffer.byteLength; offset += 2) {
    out.push(view.getInt16(offset, true));
  }
  return out;
}

describe("floatToInt16", () => {
  it.each([
    [0, 0],
    [1, 32767],
    [-1, -32768],
    [0.5, 16384],
    [-0.5, -16384],
    [1.5, 32767],
    [-7, -32768],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 32767],
    [Number.NEGATIVE_INFINITY, -32768],
  ])("%s -> %s", (input, expected) => {
    expect(floatToInt16(input)).toBe(expected);
  });
});

describe("encodeWavBytes", () => {
  it("writes a byte-exact 44-byte RIFF/fmt/data header", () => {
    const left = new Float32Array([0, 0.5, -0.5]);
    const right = new Float32Array([1, -1, 0]);
    const buffer = encodeWavBytes([left, right], 44_100);
    const bytes = new Uint8Array(buffer);

    expect(buffer.byteLength).toBe(44 + 3 * 4);
    expect([...bytes.subarray(0, 44)]).toEqual([
      // "RIFF", chunk size 36 + 12 = 48
      0x52, 0x49, 0x46, 0x46, 48, 0, 0, 0,
      // "WAVE", "fmt ", fmt size 16
      0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0,
      // PCM = 1, 2 channels
      1, 0, 2, 0,
      // 44100 Hz = 0x0000AC44
      0x44, 0xac, 0, 0,
      // byte rate 176400 = 0x0002B110
      0x10, 0xb1, 0x02, 0,
      // block align 4, 16 bits
      4, 0, 16, 0,
      // "data", data size 12
      0x64, 0x61, 0x74, 0x61, 12, 0, 0, 0,
    ]);
    // Interleaved L/R frames.
    expect(samples(buffer)).toEqual([0, 32767, 16384, -32768, -16384, 0]);
  });

  it("duplicates mono into both stereo channels", () => {
    const buffer = encodeWavBytes([new Float32Array([0.25, -1])], 8000);
    const view = new DataView(buffer);
    expect(view.getUint16(22, true)).toBe(2);
    expect(samples(buffer)).toEqual([8192, 8192, -32768, -32768]);
  });

  it("keeps only the first two of wider inputs", () => {
    const channels = [0.1, 0.2, 0.9].map((v) => new Float32Array([v]));
    expect(samples(encodeWavBytes(channels, 8000))).toEqual([
      floatToInt16(0.1),
      floatToInt16(0.2),
    ]);
  });

  it("clips out-of-range samples instead of wrapping", () => {
    const buffer = encodeWavBytes([new Float32Array([2, -2, 1.0001])], 8000);
    expect(samples(buffer)).toEqual([
      32767, 32767, -32768, -32768, 32767, 32767,
    ]);
  });

  it("sizes the header fields from the frame count and rate", () => {
    const frames = 48_000 * 3;
    const buffer = encodeWavBytes([new Float32Array(frames)], 48_000);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    expect(buffer.byteLength).toBe(44 + frames * 4);
    expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(192_000);
    expect(ascii(bytes, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(frames * 4);
  });

  it("encodes an empty buffer as a bare header", () => {
    const buffer = encodeWavBytes([new Float32Array(0)], 44_100);
    expect(buffer.byteLength).toBe(44);
    expect(new DataView(buffer).getUint32(40, true)).toBe(0);
  });

  it("rounds a fractional sample rate into the header", () => {
    const view = new DataView(encodeWavBytes([new Float32Array(1)], 44_100.4));
    expect(view.getUint32(24, true)).toBe(44_100);
  });

  it("rejects bad input", () => {
    expect(() => encodeWavBytes([], 44_100)).toThrow(RangeError);
    expect(() => encodeWavBytes([new Float32Array(1)], 0)).toThrow(RangeError);
    expect(() => encodeWavBytes([new Float32Array(1)], Number.NaN)).toThrow(
      RangeError,
    );
    expect(() =>
      encodeWavBytes([new Float32Array(2), new Float32Array(3)], 44_100),
    ).toThrow(RangeError);
  });
});

describe("encodeWav", () => {
  it("returns an audio/wav Blob of a stereo encoding of the AudioBuffer", async () => {
    const buffer = fakeAudioBuffer(1, 100, 22_050, (_c, i) =>
      i % 2 ? 0.5 : -0.5,
    );
    const blob = encodeWav(buffer);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 100 * 4);
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);
    expect(view.getUint32(24, true)).toBe(22_050);
    expect(samples(bytes).slice(0, 4)).toEqual([-16384, -16384, 16384, 16384]);
  });

  it("reads both channels of a stereo buffer", async () => {
    const buffer = fakeAudioBuffer(2, 2, 8000, (c) => (c === 0 ? 1 : -1));
    const bytes = await encodeWav(buffer).arrayBuffer();
    expect(samples(bytes)).toEqual([32767, -32768, 32767, -32768]);
  });
});
