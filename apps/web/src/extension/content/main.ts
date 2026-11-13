// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Content-script entry (built as one classic IIFE: content scripts can't be
// ES modules). Only wiring lives here; behaviour is in the tested modules.
import { chromeGlobal } from "../shared/chromePorts";
import { log } from "../shared/log";
import { preciseNow } from "../shared/protocol";
import {
  ContentController,
  createMessageListener,
  onPageGesture,
  restoreSettings,
  siteOf,
} from "./controller";
import { LiveGraph } from "./liveGraph";
import { startProbe } from "./probe";
import {
  createLiveStretch,
  loadStretchFactory,
  STRETCH_MODULE_PATH,
  type ModuleImporter,
} from "./stretchLoader";
import { VideoTracker } from "./videoTracker";

const PROBE = import.meta.env.MODE === "probe";

function main(): void {
  const { runtime } = chromeGlobal();
  const moduleUrl = runtime.getURL(STRETCH_MODULE_PATH);
  // Dynamic import of the packaged library (see stretchLoader.ts); a module
  // URL can't be bundled, so the bundler must leave this import alone.
  const importer: ModuleImporter = (url) => import(/* @vite-ignore */ url);

  const startNode = async (ctx: AudioContext) => {
    if (PROBE && document.documentElement.dataset.pblProbeFailWorklet) {
      throw new Error("Probe: worklet failure injected.");
    }
    const factory = await loadStretchFactory(moduleUrl, importer);
    return createLiveStretch(ctx, factory);
  };

  const controller = new ContentController({
    site: siteOf(location.hostname),
    createContext: () => new AudioContext({ latencyHint: "interactive" }),
    createGraph: (ctx) => new LiveGraph(ctx, startNode),
    // Probe only: Playwright's page.evaluate counts as a user gesture, so the
    // e2e suite simulates a page that hasn't been clicked yet.
    hasActivation: () =>
      !(PROBE && document.documentElement.dataset.pblProbeNoActivation) &&
      navigator.userActivation.hasBeenActive,
    onGesture: (callback) => onPageGesture(window, callback),
    publish: (status) => {
      runtime
        .sendMessage({ type: "status", status })
        .catch((cause: unknown) => {
          log.warn("Couldn't report this tab's status.", cause);
        });
    },
    now: () => preciseNow(),
    log,
  });

  runtime.onMessage.addListener(createMessageListener(controller, runtime.id));
  new VideoTracker(document, () => location.href, {
    onElement: (element) => {
      controller.setVideo(element);
    },
    onVideoChanged: () => {
      controller.videoChanged();
    },
  }).start();
  void restoreSettings(runtime, controller, log);

  if (PROBE) startProbe(controller, document.documentElement, preciseNow);
}

main();
