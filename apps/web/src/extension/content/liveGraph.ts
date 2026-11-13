// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// The per-tab audio graph (FR-1, FR-2, FR-8, FR-9):
//
//   <video> → MediaElementSource ─┬─→ dry gain ─────────────────┐
//                                 └─→ Signalsmith Stretch → wet gain ┴→ destination
//
// Never silent (FR-9, AC-6). Once createMediaElementSource() has captured an
// element, its audio only comes out through this context. So:
//  - attach only to a running context (the controller checks);
//  - connect the dry path at full gain *before* the shifter is even loaded;
//  - never disconnect a captured source and never close the context: a closed
//    context or a disconnected source would mute the video. Bypass and errors
//    fall back to the dry path instead.
import type { StretchNode } from "signalsmith-stretch";
import { asEngineError, type EngineError } from "../../audio/errors";
import { PitchRamp } from "../../audio/ramp";
import { err, ok, type Result } from "../shared/result";

/** Dry/wet crossfade length (bypass and shifter start-up). */
export const CROSSFADE_S = 0.03;

export type ShifterStarter = (ctx: AudioContext) => Promise<StretchNode>;

/** The running shifter: node, latency and its ramp exist together. */
interface Shifter {
  readonly node: StretchNode;
  readonly latencyS: number;
  readonly ramp: PitchRamp;
}

export class LiveGraph {
  private readonly ctx: AudioContext;
  private readonly startNode: ShifterStarter;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly sources = new Map<HTMLMediaElement, AudioNode>();
  private shifter: Shifter | null = null;
  private starting: Promise<Result<number, EngineError>> | null = null;
  private pendingShift = 0;
  private bypassed = false;
  private onScheduleError: (error: unknown) => void = () => undefined;

  constructor(ctx: AudioContext, startNode: ShifterStarter) {
    this.ctx = ctx;
    this.startNode = startNode;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.dry.connect(ctx.destination);
    this.wet.connect(ctx.destination);
  }

  /** Called with any rejection from the shifter's message port. */
  set scheduleErrorHandler(handler: (error: unknown) => void) {
    this.onScheduleError = handler;
  }

  get context(): AudioContext {
    return this.ctx;
  }

  get shifterReady(): boolean {
    return this.shifter !== null;
  }

  get bypass(): boolean {
    return this.bypassed;
  }

  get target(): number {
    return this.shifter ? this.shifter.ramp.target : this.pendingShift;
  }

  /** The shifter's own latency in ms, once it's running. */
  get shifterMs(): number | null {
    return this.shifter ? Math.round(this.shifter.latencyS * 1000) : null;
  }

  /**
   * How far the audio trails the video (AC-3): the shifter's latency (when the
   * wet path is live) plus the context's base latency. Null before any element
   * is attached.
   */
  get addedMs(): number | null {
    if (this.sources.size === 0) return null;
    const base = this.ctx.baseLatency;
    const shifter = this.shifter && !this.bypassed ? this.shifter.latencyS : 0;
    return Math.round((shifter + (Number.isFinite(base) ? base : 0)) * 1000);
  }

  /** Capture `video` (idempotent). Its audio flows dry at once. */
  attach(video: HTMLMediaElement): Result<void, EngineError> {
    if (this.sources.has(video)) return ok(undefined);
    let source: AudioNode;
    try {
      source = this.ctx.createMediaElementSource(video);
    } catch (cause) {
      return err(
        asEngineError(
          cause,
          "unsupported",
          "Another extension or the page already controls this video's audio.",
        ),
      );
    }
    source.connect(this.dry);
    if (this.shifter) source.connect(this.shifter.node);
    this.sources.set(video, source);
    return ok(undefined);
  }

  /** Load the shifter once; resolves with its latency in seconds. Dry stays on if it fails. */
  startShifter(): Promise<Result<number, EngineError>> {
    this.starting ??= this.start();
    return this.starting;
  }

  /** Set the transpose: ramped once the shifter runs, remembered until then. */
  setShift(semitones: number): void {
    if (this.shifter) this.shifter.ramp.rampTo(semitones);
    else this.pendingShift = semitones;
  }

  /** Bypass on: crossfade to the dry path. Off: back to wet (if the shifter runs). */
  setBypass(on: boolean): void {
    this.bypassed = on;
    this.applyMix();
  }

  /** Also feed the graph's output to `target` (the e2e probe's analyser). */
  tap(target: AudioNode): void {
    this.dry.connect(target);
    this.wet.connect(target);
  }

  /** Stop any pending ramp timers. The graph itself stays up (see header). */
  dispose(): void {
    this.shifter?.ramp.cancel();
  }

  private async start(): Promise<Result<number, EngineError>> {
    let node: StretchNode;
    let latencyS: number;
    try {
      node = await this.startNode(this.ctx);
      latencyS = await node.latency();
    } catch (cause) {
      this.starting = null; // allow a later retry
      return err(
        asEngineError(cause, "processor", "The pitch shifter couldn't start."),
      );
    }
    const ramp = new PitchRamp((semitones) => {
      this.schedule(node, semitones);
    });
    ramp.set(this.pendingShift);
    this.shifter = { node, latencyS, ramp };
    node.connect(this.wet);
    for (const source of this.sources.values()) source.connect(node);
    this.schedule(node, this.pendingShift);
    this.applyMix();
    return ok(latencyS);
  }

  private schedule(node: StretchNode, semitones: number): void {
    node.schedule({ active: true, semitones }).catch((error: unknown) => {
      this.onScheduleError(error);
    });
  }

  private applyMix(): void {
    const wetOn = this.shifter !== null && !this.bypassed;
    this.fade(this.dry.gain, wetOn ? 0 : 1);
    this.fade(this.wet.gain, wetOn ? 1 : 0);
  }

  private fade(param: AudioParam, target: number): void {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + CROSSFADE_S);
  }
}
