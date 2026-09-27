import { describe, expect, it } from "vitest";
import { END_EPSILON_S, Transport } from "./transport";

function track(duration = 10): Transport {
  const t = new Transport();
  t.reset(duration);
  return t;
}

describe("Transport", () => {
  it("starts paused at 0", () => {
    const t = track();
    expect(t.playing).toBe(false);
    expect(t.duration).toBe(10);
    expect(t.position(123)).toBe(0);
  });

  it("advances at tempo 1.0 from the play anchor", () => {
    const t = track();
    t.play(100);
    expect(t.position(100)).toBe(0);
    expect(t.position(104.25)).toBeCloseTo(4.25, 12);
    // A clock reading before the anchor never moves the position backwards.
    expect(t.position(99)).toBe(0);
  });

  it("takes exactly its duration to reach the end", () => {
    const t = track(240);
    t.play(0);
    expect(t.atEnd(240 - 0.01)).toBe(false);
    expect(t.atEnd(240 - END_EPSILON_S / 2)).toBe(true);
    expect(t.position(300)).toBe(240);
    expect(t.remaining(200)).toBeCloseTo(40, 12);
  });

  it("pause freezes and play resumes from there", () => {
    const t = track();
    t.play(0);
    t.pause(3);
    t.pause(5); // no-op while paused
    expect(t.position(50)).toBe(3);
    t.play(50);
    t.play(51); // no-op while playing
    expect(t.position(52)).toBeCloseTo(5, 12);
  });

  it("seek clamps and re-anchors", () => {
    const t = track();
    t.seek(-1, 0);
    expect(t.position(0)).toBe(0);
    t.seek(20, 0);
    expect(t.position(0)).toBe(10);
    t.play(0);
    t.seek(4, 7);
    expect(t.position(8)).toBeCloseTo(5, 12);
  });

  it("restarts from 0 when played at the end", () => {
    const t = track();
    t.play(0);
    t.end();
    expect(t.playing).toBe(false);
    expect(t.position(0)).toBe(10);
    t.play(20);
    expect(t.position(21)).toBeCloseTo(1, 12);
  });

  it("reset forgets everything; negative durations become 0", () => {
    const t = track();
    t.play(0);
    t.reset(-5);
    expect(t.playing).toBe(false);
    expect(t.duration).toBe(0);
    expect(t.position(9)).toBe(0);
  });
});
