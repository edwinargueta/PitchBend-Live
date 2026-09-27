import { planRamp, RAMP_MS, RAMP_STEPS } from "./pitch";

/**
 * Tracks the pitch shift actually applied to the stretch node and glides it to
 * new targets in small timed steps.
 *
 * Why timers and not the node's own scheduling: signalsmith-stretch keeps at
 * most one future entry in its time map (every schedule() call drops entries
 * at or after the processor's current time), so a multi-point ramp can't be
 * queued ahead. Each step is applied immediately instead; the processor's STFT
 * overlap-add (120 ms blocks, 30 ms hops) smooths between steps, so there are
 * no clicks even if a timer fires late.
 */
export class PitchRamp {
  private current = 0;
  private goal = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly apply: (value: number) => void;
  private readonly durationMs: number;
  private readonly steps: number;

  constructor(
    apply: (value: number) => void,
    durationMs = RAMP_MS,
    steps = RAMP_STEPS,
  ) {
    this.apply = apply;
    this.durationMs = durationMs;
    this.steps = steps;
  }

  /** The value currently applied (mid-ramp values included). */
  get value(): number {
    return this.current;
  }

  get target(): number {
    return this.goal;
  }

  get ramping(): boolean {
    return this.timer !== undefined;
  }

  /** Jump straight to `value` without applying it (nothing is audible). */
  set(value: number): void {
    this.cancel();
    this.current = value;
    this.goal = value;
  }

  /** Stop any ramp and treat its target as reached. */
  finish(): void {
    this.set(this.goal);
  }

  /** Glide from the current value to `target`, applying each step. */
  rampTo(target: number): void {
    this.cancel();
    this.goal = target;
    if (target === this.current) return;
    const plan = planRamp(this.current, target, this.durationMs, this.steps);
    let index = 0;
    const step = (): void => {
      this.timer = undefined;
      const now = plan[index];
      if (!now) return;
      index++;
      this.current = now.value;
      const next = plan[index];
      if (next) {
        // Whole-ms delays from rounded absolute times, so rounding never drifts.
        this.timer = setTimeout(
          step,
          Math.round(next.atMs) - Math.round(now.atMs),
        );
      }
      this.apply(now.value);
    };
    step();
  }

  cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
