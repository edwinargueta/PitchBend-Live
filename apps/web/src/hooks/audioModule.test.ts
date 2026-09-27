import { describe, expect, it, vi } from "vitest";
import { loadAudioModule } from "./audioModule";

let attempts = 0;
vi.mock("../audio", () => {
  attempts += 1;
  throw new Error("chunk failed to load");
});

describe("loadAudioModule", () => {
  it("rejects when the chunk fails, and doesn't cache the failure", async () => {
    await expect(loadAudioModule()).rejects.toThrow();
    const again = loadAudioModule();
    await expect(again).rejects.toThrow();
    expect(attempts).toBeGreaterThanOrEqual(1);
  });
});
