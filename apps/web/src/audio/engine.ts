import type { StretchFactory, StretchNode } from "signalsmith-stretch";
import type { AudioEngine, EngineEvent, RenderOptions } from "./index";
import { Emitter, type Listener } from "./emitter";
import { asEngineError, EngineError } from "./errors";
import { fetchWithProgress, type FetchLike } from "./fetchProgress";
import { normalizeCents, normalizeSemitones, totalShift } from "./pitch";
import {
  abortable,
  abortError,
  noop,
  progressReporter,
  throwIfAborted,
  withTimeout,
} from "./progress";
import { PitchRamp } from "./ramp";
import { renderStretched } from "./render";
import { copyChannels, stretchOptions, transferList } from "./stretch";
import { Transport } from "./transport";

/** Gain fade on play/pause/end, so starts and stops are click-free. */
export const FADE_S = 0.03;
/** timeupdate cadence while playing (10 Hz). */
export const TICK_MS = 100;
/** Share of load() progress given to the download; decoding takes it to 95. */
export const DOWNLOAD_PCT = 90;
export const DECODED_PCT = 95;
/**
 * How long the stretch node may take to report ready. Its worklet compiles the
 * WASM on start; where WebAssembly is blocked only inside the worklet it never
 * answers, and without this the load would hang forever.
 */
export const READY_TIMEOUT_MS = 15_000;

export interface EngineDeps {
  createContext(): AudioContext;
  createOfflineContext(
    channels: number,
    length: number,
    sampleRate: number,
  ): OfflineAudioContext;
  loadStretch(): Promise<StretchFactory>;
  fetch: FetchLike;
  decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer>;
  /** Overrides READY_TIMEOUT_MS (tests). */
  readyTimeoutMs?: number;
}

/**
 * Graph: StretchNode (Signalsmith Stretch in an AudioWorklet, holding the whole
 * decoded track) -> GainNode (fades) -> destination.
 *
 * The node plays from its own copy of the buffer following a time map we
 * schedule. Every schedule() sends the complete state (active, input position,
 * output time, rate 1, pitch) computed from `Transport`, so the node's map and
 * our model can't diverge whatever order messages land in.
 *
 * Every failure is an EngineError with a `kind` (see errors.ts): load() rejects
 * with one, and failures with no promise to reject are `error` events. A load
 * superseded by another load() or dispose() still rejects with an AbortError.
 */
export class Engine implements AudioEngine {
  private readonly deps: EngineDeps;
  private readonly events = new Emitter<EngineEvent>();
  private readonly transport = new Transport();
  private readonly pitch: PitchRamp;
  private ctx: AudioContext | null = null;
  private output: GainNode | null = null;
  private node: StretchNode | null = null;
  private nodeReady: Promise<StretchNode> | null = null;
  private buffer: AudioBuffer | null = null;
  private semitones = 0;
  private cents = 0;
  private loadSeq = 0;
  private loadAbort: AbortController | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.pitch = new PitchRamp(() => {
      this.onPitchStep();
    });
  }

  get currentTime(): number {
    return this.transport.position(this.now());
  }

  get duration(): number {
    return this.transport.duration;
  }

  get isPlaying(): boolean {
    return this.transport.playing;
  }

  get audioBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  on(event: EngineEvent, cb: Listener): () => void {
    return this.events.on(event, cb);
  }

  async load(url: string, onProgress?: (pct: number) => void): Promise<void> {
    const seq = ++this.loadSeq;
    this.loadAbort?.abort();
    const abort = new AbortController();
    this.loadAbort = abort;
    const { signal } = abort;
    this.unloadTrack();
    const report = progressReporter(onProgress);
    report(0);
    try {
      const ctx = this.ensureContext();
      // Worklet + WASM setup runs while the file downloads. If it fails, the
      // load fails right away instead of after the download and decode.
      const nodeReady = this.ensureNode(ctx);
      const setupFailed = nodeReady.then(() => new Promise<never>(noop));
      setupFailed.catch(noop); // reported by whichever await sees it
      const download = fetchWithProgress(this.deps.fetch, url, signal, (f) => {
        report(f * DOWNLOAD_PCT);
      });
      const data = await abortable(
        Promise.race([download, setupFailed]),
        signal,
      );
      const decoded = this.deps
        .decode(ctx, data)
        .catch((err: unknown) =>
          Promise.reject(
            asEngineError(
              err,
              "decode",
              "This audio file couldn't be decoded.",
            ),
          ),
        );
      const buffer = await abortable(
        Promise.race([decoded, setupFailed]),
        signal,
      );
      report(DECODED_PCT);
      const node = await abortable(nodeReady, signal);
      throwIfAborted(signal);
      await abortable(this.handOff(node, buffer), signal);
      throwIfAborted(signal);
      this.buffer = buffer;
      this.transport.reset(buffer.duration);
      report(100);
    } catch (err) {
      // Superseded (by load() or dispose()): an abort, never a failure.
      if (signal.aborted) throw abortError();
      abort.abort(); // stop whatever this failed load still has running
      throw asEngineError(err, "processor", "The audio engine failed to load.");
    } finally {
      if (this.loadSeq === seq) this.loadAbort = null;
    }
  }

  play(): void {
    const { ctx, node, buffer } = this;
    if (!ctx || !node || !buffer || this.transport.playing) return;
    // Must run synchronously inside the click handler (autoplay policy, iOS).
    this.resume(ctx);
    const now = ctx.currentTime;
    this.transport.play(now);
    this.pitch.finish(); // nothing is sounding, so no glide is needed
    this.schedule(now);
    this.fade(1, now);
    this.emitTime();
    this.scheduleTick();
  }

  pause(): void {
    const { ctx } = this;
    if (!ctx || !this.transport.playing) return;
    const now = ctx.currentTime;
    this.transport.pause(now);
    this.stopTicker();
    this.pitch.finish();
    this.fade(0, now);
    // Keep the processor running under the fade, then stop it.
    this.schedule(now + FADE_S);
    this.emitTime();
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) {
      throw new RangeError(
        `seek: seconds must be finite, got ${String(seconds)}`,
      );
    }
    const { ctx } = this;
    if (!ctx || !this.buffer) return;
    const now = ctx.currentTime;
    this.transport.seek(seconds, now);
    if (this.transport.playing) {
      this.schedule(now);
      this.scheduleTick();
    }
    this.emitTime();
  }

  setSemitones(n: number): void {
    this.semitones = normalizeSemitones(n);
    this.retune();
  }

  setCents(n: number): void {
    this.cents = normalizeCents(n);
    this.retune();
  }

  async renderOffline(opts: RenderOptions): Promise<AudioBuffer> {
    const shift = totalShift(
      normalizeSemitones(opts.semitones),
      normalizeCents(opts.cents),
    );
    const source = this.buffer;
    if (!source) throw new Error("renderOffline: no audio is loaded");
    return renderStretched(this.deps, source, shift, opts.onProgress);
  }

  dispose(): void {
    this.loadSeq++;
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.stopTicker();
    this.pitch.finish();
    this.transport.reset(0);
    this.buffer = null;
    this.node?.removeEventListener("processorerror", this.onProcessorError);
    const { ctx } = this;
    this.ctx = null;
    this.output = null;
    this.node = null;
    this.nodeReady = null;
    if (ctx && ctx.state !== "closed") ctx.close().catch(noop);
  }

  // ---- internals ------------------------------------------------------------

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    let ctx: AudioContext;
    try {
      ctx = this.deps.createContext();
    } catch (err) {
      throw asEngineError(
        err,
        "unsupported",
        "This browser couldn't start Web Audio.",
      );
    }
    const output = ctx.createGain();
    output.gain.value = 0; // silent until play() fades in
    output.connect(ctx.destination);
    this.ctx = ctx;
    this.output = output;
    return ctx;
  }

  private ensureNode(ctx: AudioContext): Promise<StretchNode> {
    if (!this.nodeReady) {
      const ready = this.createNode(ctx);
      this.nodeReady = ready;
      // A failed setup (e.g. no AudioWorklet) is retried by the next load().
      ready.catch(() => {
        if (this.nodeReady === ready) this.nodeReady = null;
      });
    }
    return this.nodeReady;
  }

  private async createNode(ctx: AudioContext): Promise<StretchNode> {
    let factory: StretchFactory;
    try {
      factory = await this.deps.loadStretch();
    } catch (err) {
      // The library is a separate chunk: this is a failed download.
      throw new EngineError(
        "network",
        "Couldn't download the audio processor. Check your connection.",
        { cause: err },
      );
    }
    const node = await this.startNode(factory, ctx);
    const { output } = this;
    if (this.ctx !== ctx || !output) {
      node.disconnect();
      throw abortError("The engine was disposed");
    }
    node.connect(output);
    node.addEventListener("processorerror", this.onProcessorError);
    this.node = node;
    return node;
  }

  /**
   * Creates the node and waits for its worklet to report ready, which needs
   * WebAssembly inside the worklet. Anything that goes wrong here means this
   * browser can't run the processor: `unsupported`.
   */
  private startNode(
    factory: StretchFactory,
    ctx: AudioContext,
  ): Promise<StretchNode> {
    const ms = this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const created = Promise.resolve()
      .then(() => factory(ctx, stretchOptions()))
      .catch((err: unknown) =>
        Promise.reject(
          new EngineError(
            "unsupported",
            "The audio processor couldn't be set up in this browser.",
            { cause: err },
          ),
        ),
      );
    return withTimeout(
      created,
      ms,
      () =>
        new EngineError(
          "unsupported",
          `The audio processor didn't start within ${String(ms / 1000)} s. WebAssembly may be blocked by this browser's security settings.`,
          { hint: "no-wasm" },
        ),
      (late) => {
        late.disconnect();
      },
    );
  }

  /** Hands the decoded channels to the node's worklet. */
  private async handOff(node: StretchNode, buffer: AudioBuffer): Promise<void> {
    try {
      const channels = copyChannels(buffer);
      // Sent back to back so a newer load's pair always lands after this one.
      void node.dropBuffers();
      await node.addBuffers(channels, transferList(channels));
    } catch (err) {
      throw new EngineError(
        "processor",
        "Couldn't pass the audio to the audio processor.",
        { cause: err },
      );
    }
  }

  /** Stop playback and forget the current track (keeps context and node). */
  private unloadTrack(): void {
    const { ctx } = this;
    this.stopTicker();
    this.pitch.finish();
    if (ctx && this.transport.playing) {
      const now = ctx.currentTime;
      this.transport.pause(now);
      this.fade(0, now);
      this.schedule(now + FADE_S);
    }
    this.transport.reset(0);
    this.buffer = null;
  }

  private resume(ctx: AudioContext): void {
    if (ctx.state === "running") return;
    ctx.resume().catch((err: unknown) => {
      // A context closed by dispose() rejects its pending resume: not an error.
      if (this.ctx !== ctx) return;
      // play() works again: the next press resumes again.
      this.fail(
        new EngineError(
          "playback",
          "The browser didn't allow audio playback to start.",
          { cause: err },
        ),
      );
    });
  }

  /** Send the complete playback state, effective at AudioContext time `output`. */
  private schedule(output: number): void {
    const { node } = this;
    if (!node) return;
    void node.schedule({
      output,
      active: this.transport.playing,
      input: this.transport.position(output),
      rate: 1, // pitch shifting never changes tempo
      semitones: this.pitch.value,
    });
  }

  private fade(target: number, now: number): void {
    const gain = this.output?.gain;
    if (!gain) return;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(target, now + FADE_S);
  }

  private retune(): void {
    const target = totalShift(this.semitones, this.cents);
    if (this.transport.playing && this.node) {
      this.pitch.rampTo(target);
    } else {
      this.pitch.set(target); // silent: the next play() sends it
    }
  }

  private onPitchStep(): void {
    if (this.ctx && this.transport.playing) this.schedule(this.ctx.currentTime);
  }

  private scheduleTick(): void {
    this.stopTicker();
    const { ctx } = this;
    if (!ctx || !this.transport.playing) return;
    // Tick early when the end is near, so `ended` fires on time.
    const remainingMs = this.transport.remaining(ctx.currentTime) * 1000;
    const delay = Math.min(TICK_MS, Math.max(1, remainingMs));
    this.tickTimer = setTimeout(() => {
      this.tick();
    }, delay);
  }

  private stopTicker(): void {
    if (this.tickTimer !== undefined) {
      clearTimeout(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private tick(): void {
    this.tickTimer = undefined;
    const { ctx } = this;
    if (!ctx || !this.transport.playing) return;
    if (this.transport.atEnd(ctx.currentTime)) {
      this.end(ctx.currentTime);
      return;
    }
    this.emitTime();
    this.scheduleTick();
  }

  private end(now: number): void {
    this.transport.end();
    this.pitch.finish();
    this.fade(0, now);
    this.schedule(now);
    this.emitTime();
    this.events.emit("ended");
  }

  private emitTime(): void {
    this.events.emit("timeupdate", this.currentTime);
  }

  private fail(err: EngineError): void {
    if (this.transport.playing) {
      this.transport.pause(this.now());
      this.stopTicker();
      this.pitch.finish();
    }
    this.events.emit("error", err);
  }

  private readonly onProcessorError = (event?: Event): void => {
    this.fail(
      new EngineError(
        "processor",
        "The audio processor stopped unexpectedly.",
        { cause: processorErrorCause(event) },
      ),
    );
  };
}

/** What a processorerror event says: an ErrorEvent may carry details, a bare Event (Chromium) doesn't. */
function processorErrorCause(event?: Event): unknown {
  if (!(event instanceof ErrorEvent)) return undefined;
  const error: unknown = event.error;
  return error ?? (event.message || undefined);
}

export function createEngine(deps: EngineDeps): AudioEngine {
  return new Engine(deps);
}
