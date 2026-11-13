// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Service-worker entry. Listeners are registered synchronously at the top
// level, as MV3 requires for a worker that's woken by events.
import { chromeGlobal } from "../shared/chromePorts";
import { log } from "../shared/log";
import { preciseNow } from "../shared/protocol";
import {
  createWorkerMessageListener,
  forgetTab,
  handleShortcut,
  installPanelBehavior,
} from "./serviceWorker";

const chrome = chromeGlobal();
const session = chrome.storage.session;

void installPanelBehavior(chrome.sidePanel, log);

chrome.commands.onCommand.addListener((name, tab) => {
  void handleShortcut(name, tab, chrome.tabs, log, preciseNow);
});

chrome.runtime.onMessage.addListener(
  createWorkerMessageListener(chrome.runtime.id, session, log),
);

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetTab(session, tabId, log);
});

if (import.meta.env.MODE === "probe") {
  // e2e only: headless Chromium can't press browser-level shortcuts, so the
  // suite calls the same handler through this hook (AC-11).
  (globalThis as { pblShortcut?: unknown }).pblShortcut = (name: string) =>
    handleShortcut(name, undefined, chrome.tabs, log, preciseNow);
}
