// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// A fake `chrome` for panel tests: events you can fire, tabs you can script.
import { vi } from "vitest";
import type {
  ChromeEvent,
  MessageListener,
  PanelChrome,
  TabInfo,
} from "../shared/chromePorts";

export interface FakeEvent<
  T extends (...args: never[]) => unknown,
> extends ChromeEvent<T> {
  emit(...args: Parameters<T>): void;
  readonly size: number;
}

export function fakeEvent<
  T extends (...args: never[]) => unknown,
>(): FakeEvent<T> {
  const listeners = new Set<T>();
  return {
    addListener: (callback) => {
      listeners.add(callback);
    },
    removeListener: (callback) => {
      listeners.delete(callback);
    },
    emit: (...args) => {
      for (const listener of listeners) listener(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}

export function fakePanelChrome(activeTab: TabInfo | undefined) {
  const onMessage = fakeEvent<MessageListener>();
  const onActivated =
    fakeEvent<(info: { tabId: number; windowId: number }) => void>();
  const onUpdated =
    fakeEvent<
      (tabId: number, change: { url?: string; status?: string }) => void
    >();
  const onRemoved = fakeEvent<(tabId: number) => void>();
  const state = { active: activeTab };
  const sendMessage = vi.fn<
    (tabId: number, message: unknown) => Promise<unknown>
  >(() => Promise.reject(new Error("no receiver")));
  const get = vi.fn((tabId: number) =>
    state.active?.id === tabId
      ? Promise.resolve(state.active)
      : Promise.reject(new Error("no tab")),
  );
  const query = vi.fn(() =>
    Promise.resolve(state.active ? [state.active] : []),
  );
  const chrome: PanelChrome = {
    runtime: {
      id: "ext",
      getURL: (path) => `chrome-extension://ext/${path}`,
      sendMessage: () => Promise.resolve(undefined),
      onMessage,
    },
    tabs: { query, get, sendMessage, onActivated, onUpdated, onRemoved },
  };
  return {
    chrome,
    state,
    sendMessage,
    get,
    query,
    onMessage,
    onActivated,
    onUpdated,
  };
}
