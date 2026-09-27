// Thin browser glue: constructor lookup (incl. Safari's prefixed names),
// feature checks (WebAssembly, AAC), callback-style decodeAudioData, and the
// iOS audio session.
import { EngineError, type EngineErrorOptions } from "./errors";

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;
type OfflineContextCtor = new (
  channels: number,
  length: number,
  sampleRate: number,
) => OfflineAudioContext;

interface TypeSupport {
  isTypeSupported?: (type: string) => boolean;
}

/** The globals we look up, all optional so feature detection type-checks. */
export interface AudioGlobals {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
  OfflineAudioContext?: OfflineContextCtor;
  webkitOfflineAudioContext?: OfflineContextCtor;
  navigator?: { audioSession?: { type: string } };
  WebAssembly?: { Module?: new (bytes: Uint8Array<ArrayBuffer>) => unknown };
  Audio?: new () => { canPlayType(type: string): string };
  MediaSource?: TypeSupport;
  /** Safari 17+ on iPhone has only ManagedMediaSource. */
  ManagedMediaSource?: TypeSupport;
}

function audioGlobals(): AudioGlobals {
  return globalThis as unknown as AudioGlobals;
}

/** An EngineError of kind `unsupported`: this browser can't run the engine. */
export class AudioUnsupportedError extends EngineError {
  override name = "AudioUnsupportedError";

  constructor(message: string, options: EngineErrorOptions = {}) {
    super("unsupported", message, options);
  }
}

/** The smallest valid WebAssembly module (magic number + version 1). */
const EMPTY_WASM_MODULE = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/**
 * The pitch shifter is WebAssembly. Without it (Chromium `--jitless`, Edge's
 * enhanced security, Safari's Lockdown Mode, some managed-browser policies)
 * its worklet would never report ready, so fail up front instead. Compiling a
 * tiny module (synchronous, 8 bytes, allowed on the main thread) also catches
 * a WebAssembly global that exists but isn't allowed to compile (e.g. a CSP
 * without 'wasm-unsafe-eval'). The worklet inherits the page's JS engine flags
 * and policy; anything that still differs there is caught by the processor's
 * start-up timeout (engine.ts).
 */
export function checkWebAssembly(g: AudioGlobals = audioGlobals()): void {
  const Module = g.WebAssembly?.Module;
  if (typeof Module !== "function") {
    throw new AudioUnsupportedError(
      "WebAssembly is disabled in this browser, and the pitch shifter needs it. Browser security settings (such as a JIT-less or enhanced-security mode) or a managed-browser policy may be turning it off.",
      { hint: "no-wasm" },
    );
  }
  try {
    new Module(new Uint8Array(EMPTY_WASM_MODULE));
  } catch (err) {
    throw new AudioUnsupportedError(
      "This browser blocked WebAssembly, which the pitch shifter needs. Browser security settings or a policy may be blocking it.",
      { cause: err, hint: "no-wasm" },
    );
  }
}

/**
 * A realtime context. Created suspended when there has been no user gesture
 * yet (autoplay policy); play() resumes it from the click handler.
 */
export function createAudioContext(
  g: AudioGlobals = audioGlobals(),
): AudioContext {
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) {
    throw new AudioUnsupportedError("This browser doesn't support Web Audio.");
  }
  checkWebAssembly(g);
  const ctx = new Ctor({ latencyHint: "interactive" });
  // Safari < 14.1 and some embedded browsers have no AudioWorklet.
  if (!(ctx as { audioWorklet?: AudioWorklet }).audioWorklet) {
    void ctx.close().catch(() => undefined);
    throw new AudioUnsupportedError(
      "This browser doesn't support AudioWorklet, which live pitch shifting needs.",
    );
  }
  preferPlaybackSession(g);
  return ctx;
}

/** iOS: play through the silent switch like a media app (Safari 16.4+ only). */
export function preferPlaybackSession(g: AudioGlobals = audioGlobals()): void {
  const session = g.navigator?.audioSession;
  if (!session) return;
  try {
    session.type = "playback";
  } catch {
    // Read-only or unsupported value: keep the default session.
  }
}

export function createOfflineContext(
  channels: number,
  length: number,
  sampleRate: number,
  g: AudioGlobals = audioGlobals(),
): OfflineAudioContext {
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!Ctor) {
    throw new AudioUnsupportedError("This browser can't render audio offline.");
  }
  // Positional form: older Safari has no options-object constructor.
  return new Ctor(channels, length, sampleRate);
}

/** KeyShift's playback format (D8): AAC-LC in an MP4 (.m4a) container. */
export const AAC_MIME = 'audio/mp4; codecs="mp4a.40.2"';

/**
 * Whether the browser says it can play AAC: false if the media element answers
 * "" or MediaSource rejects the type (Chromium builds without proprietary
 * codecs, e.g. VS Code's built-in browser, do both), true if every probe that
 * answered says yes, null if neither can be asked. These describe the media pipeline, not Web Audio's
 * decoder, so this only explains a decode failure and never blocks a load.
 */
export function aacSupported(g: AudioGlobals = audioGlobals()): boolean | null {
  const answers: boolean[] = [];
  for (const source of [g.MediaSource, g.ManagedMediaSource]) {
    try {
      if (typeof source?.isTypeSupported === "function") {
        answers.push(source.isTypeSupported(AAC_MIME));
        break;
      }
    } catch {
      // A throwing probe just can't answer.
    }
  }
  try {
    if (g.Audio) answers.push(new g.Audio().canPlayType(AAC_MIME) !== "");
  } catch {
    // Same.
  }
  if (answers.length === 0) return null;
  return answers.every(Boolean);
}

/** The decode failure to report, naming AAC when the browser says it lacks it. */
export function decodeError(
  cause: unknown,
  g: AudioGlobals = audioGlobals(),
): EngineError {
  if (aacSupported(g) === false) {
    return new EngineError(
      "decode",
      `This browser can't decode AAC audio (${AAC_MIME}), the format KeyShift plays. Browsers built without proprietary codecs, such as embedded ones, lack it.`,
      { cause, hint: "no-aac" },
    );
  }
  return new EngineError("decode", "This audio file couldn't be decoded.", {
    cause,
  });
}

type LegacyDecode = (
  data: ArrayBuffer,
  success: (buffer: AudioBuffer) => void,
  failure: (err?: unknown) => void,
) => Promise<AudioBuffer> | undefined;

/**
 * decodeAudioData that works with both the promise form and the callback-only
 * form (Safari < 14.1 returns undefined and may call back with a null error).
 * Rejects with an EngineError of kind `decode` (see decodeError).
 */
export function decodeAudio(
  ctx: BaseAudioContext,
  data: ArrayBuffer,
  g: AudioGlobals = audioGlobals(),
): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let failed = false;
    const fail = (err?: unknown): void => {
      // Modern browsers call back *and* reject: build the error once.
      if (failed) return;
      failed = true;
      reject(decodeError(err, g));
    };
    try {
      const decode = ctx.decodeAudioData.bind(ctx) as unknown as LegacyDecode;
      const result = decode(data, resolve, fail);
      if (result && typeof result.then === "function") {
        result.then(resolve, fail);
      }
    } catch (err) {
      fail(err);
    }
  });
}
