// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// The small slice of the `chrome.*` extension API this extension uses, typed
// here instead of pulling in @types/chrome. Code takes these as parameters
// (dependency inversion), so tests pass fakes and only the entry files touch
// the real global.

export interface ChromeEvent<T extends (...args: never[]) => unknown> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
}

export interface MessageSender {
  readonly id?: string;
  readonly tab?: { readonly id?: number };
}

export type MessageListener = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

export interface RuntimePort {
  readonly id: string;
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: ChromeEvent<MessageListener>;
}

export interface TabInfo {
  readonly id?: number;
  readonly url?: string;
  readonly active?: boolean;
  readonly windowId?: number;
}

export interface TabQuery {
  active?: boolean;
  lastFocusedWindow?: boolean;
  currentWindow?: boolean;
}

export interface TabsPort {
  query(query: TabQuery): Promise<TabInfo[]>;
  get(tabId: number): Promise<TabInfo>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
  readonly onActivated: ChromeEvent<
    (info: { tabId: number; windowId: number }) => void
  >;
  readonly onUpdated: ChromeEvent<
    (tabId: number, change: { url?: string; status?: string }) => void
  >;
  readonly onRemoved: ChromeEvent<(tabId: number) => void>;
}

export interface SessionStoragePort {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface CommandsPort {
  readonly onCommand: ChromeEvent<(command: string, tab?: TabInfo) => void>;
}

export interface SidePanelPort {
  setPanelBehavior(behavior: {
    openPanelOnActionClick: boolean;
  }): Promise<void>;
}

/** What a content script may use. */
export interface ContentChrome {
  readonly runtime: RuntimePort;
}

/** What the service worker uses. */
export interface WorkerChrome {
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
  readonly storage: { readonly session: SessionStoragePort };
  readonly commands: CommandsPort;
  readonly sidePanel: SidePanelPort;
}

/** What the side panel uses. */
export interface PanelChrome {
  readonly runtime: RuntimePort;
  readonly tabs: TabsPort;
}

/**
 * The real `chrome` global, for entry files only. Throws outside an extension.
 * Typed as the widest surface; each context passes on only the slice it may
 * use (a content script gets just `runtime`).
 */
export function chromeGlobal(scope: object = globalThis): WorkerChrome {
  const api = (scope as { chrome?: unknown }).chrome;
  if (typeof api !== "object" || api === null) {
    throw new Error("The chrome extension API isn't available here.");
  }
  return api as WorkerChrome;
}
