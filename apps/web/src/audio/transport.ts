/** Positions within this distance of the end count as "at the end" (seconds). */
export const END_EPSILON_S = 1e-3;

/**
 * Playback position model, driven by AudioContext time. While playing, the
 * position is `anchorPos + (now - anchorTime)`: tempo is always 1.0, so a song
 * takes exactly its duration to play. The stretch node is scheduled from the
 * same numbers, so the model and the audio never drift apart.
 */
export class Transport {
  private isPlaying = false;
  private anchorPos = 0;
  private anchorTime = 0;
  private length = 0;

  get playing(): boolean {
    return this.isPlaying;
  }

  get duration(): number {
    return this.length;
  }

  /** Forget everything; a new track of `duration` seconds, paused at 0. */
  reset(duration: number): void {
    this.isPlaying = false;
    this.anchorPos = 0;
    this.anchorTime = 0;
    this.length = Math.max(0, duration);
  }

  position(now: number): number {
    if (!this.isPlaying) return this.anchorPos;
    const pos = this.anchorPos + Math.max(0, now - this.anchorTime);
    return Math.min(this.length, pos);
  }

  remaining(now: number): number {
    return this.length - this.position(now);
  }

  atEnd(now: number): boolean {
    return this.remaining(now) <= END_EPSILON_S;
  }

  /** Start from the current position, or from 0 if it's at the end (like <audio>). */
  play(now: number): void {
    if (this.isPlaying) return;
    if (this.atEnd(now)) this.anchorPos = 0;
    this.isPlaying = true;
    this.anchorTime = now;
  }

  pause(now: number): void {
    if (!this.isPlaying) return;
    this.anchorPos = this.position(now);
    this.isPlaying = false;
  }

  seek(seconds: number, now: number): void {
    this.anchorPos = Math.min(this.length, Math.max(0, seconds));
    this.anchorTime = now;
  }

  /** Playback reached the end. */
  end(): void {
    this.isPlaying = false;
    this.anchorPos = this.length;
  }
}
