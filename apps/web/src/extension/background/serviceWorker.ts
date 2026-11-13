// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Service-worker logic (FR-4, FR-7): keyboard shortcuts → the active YouTube
// tab, and each tab's settings in chrome.storage.session (memory only, cleared
// with the tab), so a reload keeps the transpose. Nothing here touches the
// network or persistent storage (AC-9, AC-13).
import type { Logger } from "../shared/log";
import type {
  MessageListener,
  SessionStoragePort,
  SidePanelPort,
  TabInfo,
  TabsPort,
} from "../shared/chromePorts";
import {
  isRestoreRequest,
  isStatusMessage,
  type Command,
  type TabSettings,
} from "../shared/protocol";

type ShortcutCommand = Exclude<Command, { type: "getStatus" }>;

/** manifest.json "commands" names → what they do (AC-11). */
export const SHORTCUTS: ReadonlyMap<string, ShortcutCommand> = new Map<
  string,
  ShortcutCommand
>([
  ["transpose-up", { type: "nudge", delta: 1 }],
  ["transpose-down", { type: "nudge", delta: -1 }],
  ["transpose-reset", { type: "reset" }],
  ["toggle-bypass", { type: "toggleBypass" }],
]);

/** The two origins in host_permissions and the content-script matches. */
export const YOUTUBE_ORIGINS: readonly string[] = [
  "https://www.youtube.com/",
  "https://music.youtube.com/",
];

export function isYouTubeUrl(url: string | undefined): boolean {
  return (
    url !== undefined &&
    YOUTUBE_ORIGINS.some((origin) => url.startsWith(origin))
  );
}

export function storageKey(tabId: number): string {
  return `tab:${String(tabId)}`;
}

/** Send a shortcut's command to the tab it was pressed in (or the active tab). */
export async function handleShortcut(
  name: string,
  tab: TabInfo | undefined,
  tabs: Pick<TabsPort, "query" | "sendMessage">,
  log: Logger,
  now: () => number,
): Promise<void> {
  const command = SHORTCUTS.get(name);
  if (!command) return;
  const target =
    tab?.id === undefined
      ? (await tabs.query({ active: true, lastFocusedWindow: true }))[0]
      : tab;
  if (target?.id === undefined || !isYouTubeUrl(target.url)) return;
  try {
    await tabs.sendMessage(target.id, { ...command, sentAt: now() });
  } catch (cause) {
    log.warn(
      "This YouTube tab isn't running PitchBend Live yet; reload it.",
      cause,
    );
  }
}

async function saveSettings(
  storage: SessionStoragePort,
  tabId: number,
  settings: TabSettings,
  log: Logger,
): Promise<void> {
  try {
    await storage.set({ [storageKey(tabId)]: settings });
  } catch (cause) {
    log.warn("Couldn't remember this tab's settings.", cause);
  }
}

async function readSettings(
  storage: SessionStoragePort,
  tabId: number,
  log: Logger,
): Promise<unknown> {
  const key = storageKey(tabId);
  try {
    const items = await storage.get(key);
    return items[key] ?? null;
  } catch (cause) {
    log.warn("Couldn't read this tab's settings.", cause);
    return null;
  }
}

/**
 * Content scripts report status (saved per tab) and ask for their settings
 * after a reload. Only this extension's own content scripts are heard.
 */
export function createWorkerMessageListener(
  extensionId: string,
  storage: SessionStoragePort,
  log: Logger,
): MessageListener {
  return (message, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (sender.id !== extensionId || tabId === undefined) return undefined;
    if (isStatusMessage(message)) {
      void saveSettings(storage, tabId, message.status.settings, log);
      return undefined;
    }
    if (isRestoreRequest(message)) {
      void readSettings(storage, tabId, log).then(sendResponse);
      return true; // answered asynchronously
    }
    return undefined;
  };
}

/** A closed tab's settings are deleted (FR-7). */
export async function forgetTab(
  storage: SessionStoragePort,
  tabId: number,
  log: Logger,
): Promise<void> {
  try {
    await storage.remove(storageKey(tabId));
  } catch (cause) {
    log.warn("Couldn't clear a closed tab's settings.", cause);
  }
}

/** Clicking the toolbar icon opens the side panel. */
export async function installPanelBehavior(
  sidePanel: SidePanelPort,
  log: Logger,
): Promise<void> {
  try {
    await sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (cause) {
    log.error("Couldn't set up the side panel.", cause);
  }
}
