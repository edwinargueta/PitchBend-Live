// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Connects the side panel to the content script of the tab it controls
// (FR-3): the active tab of the panel's window, or `?tabId=` (the e2e suite
// opens the panel as a normal page). An external store read with
// useSyncExternalStore: all chrome I/O lives here, so Panel stays
// presentational and this is testable without React.
import type { PanelChrome, TabInfo } from "../shared/chromePorts";
import {
  isStatusMessage,
  isTabStatus,
  isYouTubeUrl,
  type Command,
  type TabStatus,
} from "../shared/protocol";

export type PanelView =
  | { readonly kind: "loading" }
  | { readonly kind: "not-youtube" }
  | { readonly kind: "no-receiver"; readonly tabId: number }
  | {
      readonly kind: "ready";
      readonly tabId: number;
      readonly status: TabStatus;
    };

/** `?tabId=12` → 12; anything else → null. */
export function tabIdOverride(search: string): number | null {
  const raw = new URLSearchParams(search).get("tabId");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function tabIdOf(view: PanelView): number | null {
  return view.kind === "ready" || view.kind === "no-receiver"
    ? view.tabId
    : null;
}

export class PanelStore {
  private readonly chrome: PanelChrome;
  private readonly override: number | null;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private view: PanelView = { kind: "loading" };
  /** Only the newest request may change the view (replies can arrive out of order). */
  private seq = 0;

  constructor(chrome: PanelChrome, override: number | null, now: () => number) {
    this.chrome = chrome;
    this.override = override;
    this.now = now;
  }

  readonly getView = (): PanelView => this.view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  /** Send a command to the tab (stamped for AC-2); the reply is the new status. */
  readonly send = (command: Command): void => {
    const tabId = tabIdOf(this.view);
    if (tabId === null) return;
    const stamped: Command =
      command.type === "getStatus"
        ? command
        : { ...command, sentAt: this.now() };
    void this.ask(tabId, stamped, ++this.seq);
  };

  /** Re-resolve the target tab and read its status. */
  readonly refresh = async (): Promise<void> => {
    const seq = ++this.seq;
    const tab = await this.targetTab();
    const tabId = tab?.id;
    if (tabId === undefined || !isYouTubeUrl(tab?.url)) {
      this.set({ kind: "not-youtube" }, seq);
      return;
    }
    await this.ask(tabId, { type: "getStatus" }, seq);
  };

  private readonly onActivated = (): void => {
    if (this.override === null) void this.refresh();
  };

  private readonly onUpdated = (
    tabId: number,
    change: { url?: string; status?: string },
  ): void => {
    const watching = tabIdOf(this.view);
    const relevant = watching === null || watching === tabId;
    const navigated = change.url !== undefined || change.status === "complete";
    if (relevant && navigated) void this.refresh();
  };

  private readonly onMessage = (
    message: unknown,
    sender: { tab?: { id?: number } },
  ): undefined => {
    const tabId = tabIdOf(this.view);
    if (
      isStatusMessage(message) &&
      tabId !== null &&
      sender.tab?.id === tabId
    ) {
      this.set({ kind: "ready", tabId, status: message.status }, this.seq);
    }
    return undefined;
  };

  private start(): void {
    this.chrome.tabs.onActivated.addListener(this.onActivated);
    this.chrome.tabs.onUpdated.addListener(this.onUpdated);
    this.chrome.runtime.onMessage.addListener(this.onMessage);
    void this.refresh();
  }

  private stop(): void {
    this.chrome.tabs.onActivated.removeListener(this.onActivated);
    this.chrome.tabs.onUpdated.removeListener(this.onUpdated);
    this.chrome.runtime.onMessage.removeListener(this.onMessage);
  }

  private async targetTab(): Promise<TabInfo | undefined> {
    try {
      if (this.override !== null) {
        return await this.chrome.tabs.get(this.override);
      }
      const [tab] = await this.chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return tab;
    } catch {
      return undefined; // the tab closed: shown as "not a YouTube tab"
    }
  }

  private async ask(
    tabId: number,
    command: Command,
    seq: number,
  ): Promise<void> {
    let view: PanelView;
    try {
      const status = await this.chrome.tabs.sendMessage(tabId, command);
      view = isTabStatus(status)
        ? { kind: "ready", tabId, status }
        : { kind: "no-receiver", tabId };
    } catch {
      // No content script in the tab (opened before install or update):
      // shown as "reload this tab".
      view = { kind: "no-receiver", tabId };
    }
    this.set(view, seq);
  }

  private set(view: PanelView, seq: number): void {
    if (seq !== this.seq) return;
    this.view = view;
    for (const listener of this.listeners) listener();
  }
}
