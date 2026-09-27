// The audio engine (Signalsmith WASM + worklet) is heavy, so it's never in the
// input screen's bundle: every consumer goes through this dynamic import, which
// Vite splits into its own chunk and the browser fetches once.
type AudioModule = typeof import("../audio");

let pending: Promise<AudioModule> | null = null;

export function loadAudioModule(): Promise<AudioModule> {
  pending ??= import("../audio").catch((err: unknown) => {
    pending = null; // allow a retry after a failed chunk load
    throw err;
  });
  return pending;
}
