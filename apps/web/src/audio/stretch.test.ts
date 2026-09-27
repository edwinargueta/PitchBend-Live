import { describe, expect, it } from "vitest";
import { checkpointFrames, RENDER_CHECKPOINTS, RENDER_QUANTUM } from "./render";
import {
  copyChannels,
  loadStretchFactory,
  STRETCH_CHANNELS,
  stretchOptions,
  transferList,
} from "./stretch";
import { fakeAudioBuffer } from "./testing/fakes";

describe("stretch helpers", () => {
  it("builds node options with one input and a stereo output", () => {
    expect(STRETCH_CHANNELS).toBe(2);
    expect(stretchOptions()).toEqual({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    expect(stretchOptions(1).outputChannelCount).toEqual([1]);
  });

  it("copies up to two channels into their own buffers", () => {
    const buffer = fakeAudioBuffer(3, 4, 48000, (c, i) => c * 10 + i);
    const copies = copyChannels(buffer);
    expect(copies.map((c) => [...c])).toEqual([
      [0, 1, 2, 3],
      [10, 11, 12, 13],
    ]);
    expect(copies[0]).not.toBe(buffer.getChannelData(0));
    expect(copies[0]?.buffer).not.toBe(copies[1]?.buffer);
    expect(copies[0]?.buffer.byteLength).toBe(16);
    expect(transferList(copies)).toEqual(copies.map((c) => c.buffer));
  });

  it("loads the real signalsmith-stretch factory lazily", async () => {
    const factory = await loadStretchFactory();
    expect(typeof factory).toBe("function");
  });
});

describe("checkpointFrames", () => {
  it("returns quantum-aligned, unique frames strictly inside the render", () => {
    const length = 44_100 * 240;
    const frames = checkpointFrames(length);
    expect(frames).toHaveLength(RENDER_CHECKPOINTS - 1);
    for (const frame of frames) {
      expect(frame % RENDER_QUANTUM).toBe(0);
      expect(frame).toBeGreaterThan(0);
      expect(frame).toBeLessThan(length);
    }
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
  });

  it("collapses checkpoints on short renders", () => {
    expect(checkpointFrames(1000, 40)).toEqual([
      128, 256, 384, 512, 640, 768, 896,
    ]);
    expect(checkpointFrames(100)).toEqual([]);
  });
});
