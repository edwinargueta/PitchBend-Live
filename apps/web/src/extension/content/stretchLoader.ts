// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Loads Signalsmith Stretch inside YouTube's page without a Blob URL.
//
// Why (spike E1, ADR 0009): the library normally wraps its worklet code in a
// Blob URL, which YouTube's CSP refuses. The same .mjs file also registers the
// processor when it's loaded in an AudioWorklet scope, so the extension ships
// it unchanged as a web-accessible resource, imports it from that URL on the
// main thread, and points `moduleUrl` at the same file for addModule().
import type { StretchFactory, StretchNode } from "signalsmith-stretch";
import { EngineError } from "../../audio/errors";

/** Where the build copies node_modules/signalsmith-stretch/SignalsmithStretch.mjs. */
export const STRETCH_MODULE_PATH = "vendor/signalsmith-stretch.mjs";

/**
 * 60 ms blocks: measured shifter latency 60 ms (the default preset is 120 ms),
 * keeping the added delay behind the video within the 80 ms budget (AC-3).
 */
export const LIVE_STRETCH_CONFIG = { blockMs: 60, intervalMs: 15 } as const;

/** Give up on the worklet after this long and stay on the dry path. */
export const START_TIMEOUT_MS = 5000;

/**
 * Same shape as the web engine's (src/audio/stretch.ts), kept local so the
 * content script doesn't bundle that module's dynamic import of the library.
 */
export const LIVE_STRETCH_OPTIONS: AudioWorkletNodeOptions = {
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [2],
};

export type ModuleImporter = (url: string) => Promise<unknown>;

/** Import the packaged library and aim its worklet loader at the same file. */
export async function loadStretchFactory(
  url: string,
  importer: ModuleImporter,
): Promise<StretchFactory> {
  let mod: unknown;
  try {
    mod = await importer(url);
  } catch (cause) {
    throw new EngineError(
      "unsupported",
      "The pitch shifter's code couldn't be loaded.",
      { cause },
    );
  }
  const factory = (mod as { default?: unknown } | null)?.default;
  if (typeof factory !== "function") {
    throw new EngineError(
      "unsupported",
      "The pitch shifter's code didn't load correctly.",
    );
  }
  const typed = factory as StretchFactory;
  typed.moduleUrl = url;
  return typed;
}

/** Rejects with an EngineError of kind `unsupported` if `promise` takes too long. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new EngineError("unsupported", message, { hint: "no-wasm" }));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A stretch node in live-input mode, configured for low latency. */
export async function createLiveStretch(
  ctx: BaseAudioContext,
  factory: StretchFactory,
  timeoutMs = START_TIMEOUT_MS,
): Promise<StretchNode> {
  const node = await withTimeout(
    factory(ctx, LIVE_STRETCH_OPTIONS),
    timeoutMs,
    "The pitch shifter didn't start. This browser or page may be blocking WebAssembly.",
  );
  await node.configure(LIVE_STRETCH_CONFIG);
  return node;
}
