// Typed audio-engine failures, so the UI can say what went wrong and what to do.
// Kept free of other engine imports: the player imports it without pulling in
// the engine, the worklet or the WASM.

/**
 * - `unsupported`: the browser can't run the engine (no Web Audio, no
 *   AudioWorklet, WebAssembly blocked, or the processor never started).
 * - `network`: the audio (or the engine's code) couldn't be downloaded.
 * - `decode`: decodeAudioData rejected the file.
 * - `processor`: the AudioWorklet processor failed after it started.
 * - `playback`: the AudioContext couldn't be resumed on play().
 */
export type EngineErrorKind =
  "unsupported" | "network" | "decode" | "processor" | "playback";

/**
 * What the browser told us about the likely cause, when it told us anything:
 * `no-aac` (decoding failed and the browser says it can't play AAC) or
 * `no-wasm` (WebAssembly is missing, blocked, or the processor never started).
 */
export type EngineErrorHint = "no-aac" | "no-wasm";

export interface EngineErrorOptions {
  cause?: unknown;
  hint?: EngineErrorHint;
}

export class EngineError extends Error {
  override name = "EngineError";
  readonly kind: EngineErrorKind;
  readonly hint: EngineErrorHint | null;

  constructor(
    kind: EngineErrorKind,
    message: string,
    options: EngineErrorOptions = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.kind = kind;
    this.hint = options.hint ?? null;
  }
}

export function isEngineError(err: unknown): err is EngineError {
  return err instanceof EngineError;
}

/** `err` itself when it's already classified, else an EngineError wrapping it. */
export function asEngineError(
  err: unknown,
  kind: EngineErrorKind,
  message: string,
): EngineError {
  return isEngineError(err)
    ? err
    : new EngineError(kind, message, { cause: err });
}
