// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { describe, expect, it, vi } from "vitest";
import type { TabStatus } from "../shared/protocol";
import {
  createWorkerMessageListener,
  forgetTab,
  handleShortcut,
  installPanelBehavior,
  isYouTubeUrl,
  SHORTCUTS,
  storageKey,
} from "./serviceWorker";

const WATCH = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const newLog = () => ({ warn: vi.fn(), error: vi.fn() });

function fakeStorage() {
  const items = new Map<string, unknown>();
  return {
    items,
    get: vi.fn((key: string) =>
      Promise.resolve(items.has(key) ? { [key]: items.get(key) } : {}),
    ),
    set: vi.fn((patch: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(patch)) items.set(k, v);
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      items.delete(key);
      return Promise.resolve();
    }),
  };
}

const status: TabStatus = {
  state: "active",
  settings: { semitones: 3, bypass: false, key: null },
  site: "youtube",
  shifterMs: 60,
  addedMs: 70,
  error: null,
  appliedAt: null,
  sentAt: null,
};

describe("isYouTubeUrl", () => {
  it.each([
    [WATCH, true],
    ["https://music.youtube.com/watch?v=x", true],
    ["https://www.youtube.com.evil.example/", false],
    ["https://example.com/", false],
    [undefined, false],
  ])("%s → %s", (url, expected) => {
    expect(isYouTubeUrl(url)).toBe(expected);
  });
});

describe("handleShortcut (AC-11)", () => {
  it.each([...SHORTCUTS])(
    "%s should send its command to the tab it was pressed in",
    async (name, command) => {
      const tabs = {
        query: vi.fn(),
        sendMessage: vi.fn(() => Promise.resolve()),
      };
      await handleShortcut(
        name,
        { id: 7, url: WATCH },
        tabs,
        newLog(),
        () => 9,
      );
      expect(tabs.query).not.toHaveBeenCalled();
      expect(tabs.sendMessage).toHaveBeenCalledWith(7, {
        ...command,
        sentAt: 9,
      });
    },
  );

  it("should fall back to the active tab when none is given", async () => {
    const tabs = {
      query: vi.fn(() => Promise.resolve([{ id: 3, url: WATCH }])),
      sendMessage: vi.fn(() => Promise.resolve()),
    };
    await handleShortcut("transpose-up", undefined, tabs, newLog(), () => 1);
    expect(tabs.query).toHaveBeenCalledWith({
      active: true,
      lastFocusedWindow: true,
    });
    expect(tabs.sendMessage).toHaveBeenCalledWith(3, {
      type: "nudge",
      delta: 1,
      sentAt: 1,
    });
  });

  it.each([
    ["an unknown command", "do-something", { id: 1, url: WATCH }, []],
    ["a prototype key", "toString", { id: 1, url: WATCH }, []],
    [
      "a non-YouTube tab",
      "transpose-up",
      { id: 1, url: "https://x.test/" },
      [],
    ],
    ["no active tab", "transpose-up", undefined, []],
  ])("should do nothing for %s", async (_label, name, tab, active) => {
    const tabs = {
      query: vi.fn(() => Promise.resolve(active)),
      sendMessage: vi.fn(() => Promise.resolve()),
    };
    await handleShortcut(name, tab, tabs, newLog(), () => 1);
    expect(tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("should log (not throw) when the tab has no content script", async () => {
    const log = newLog();
    const tabs = {
      query: vi.fn(),
      sendMessage: vi.fn(() => Promise.reject(new Error("no receiver"))),
    };
    await handleShortcut(
      "toggle-bypass",
      { id: 2, url: WATCH },
      tabs,
      log,
      () => 1,
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/reload it/),
      expect.any(Error),
    );
  });
});

describe("createWorkerMessageListener (AC-9)", () => {
  const fromTab = (id: number) => ({ id: "ext", tab: { id } });

  it("should save each tab's settings from its status", async () => {
    const storage = fakeStorage();
    const listener = createWorkerMessageListener("ext", storage, newLog());
    expect(
      listener({ type: "status", status }, fromTab(4), vi.fn()),
    ).toBeUndefined();
    await vi.waitFor(() => {
      expect(storage.items.get("tab:4")).toEqual(status.settings);
    });
  });

  it("should answer a restore request asynchronously", async () => {
    const storage = fakeStorage();
    storage.items.set(storageKey(5), status.settings);
    const listener = createWorkerMessageListener("ext", storage, newLog());
    const sendResponse = vi.fn();
    expect(listener({ type: "restoreRequest" }, fromTab(5), sendResponse)).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(status.settings);
    });
    const none = vi.fn();
    listener({ type: "restoreRequest" }, fromTab(6), none);
    await vi.waitFor(() => {
      expect(none).toHaveBeenCalledWith(null);
    });
  });

  it("should answer null and log when storage fails", async () => {
    const storage = fakeStorage();
    storage.get.mockRejectedValueOnce(new Error("gone"));
    storage.set.mockRejectedValueOnce(new Error("full"));
    const log = newLog();
    const listener = createWorkerMessageListener("ext", storage, log);
    const sendResponse = vi.fn();
    listener({ type: "restoreRequest" }, fromTab(1), sendResponse);
    listener({ type: "status", status }, fromTab(1), vi.fn());
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(null);
      expect(log.warn).toHaveBeenCalledTimes(2);
    });
  });

  it("should ignore other senders, tabless senders and other messages", () => {
    const storage = fakeStorage();
    const listener = createWorkerMessageListener("ext", storage, newLog());
    expect(
      listener(
        { type: "status", status },
        { id: "other", tab: { id: 1 } },
        vi.fn(),
      ),
    ).toBeUndefined();
    expect(
      listener({ type: "status", status }, { id: "ext" }, vi.fn()),
    ).toBeUndefined();
    expect(listener({ type: "hello" }, fromTab(1), vi.fn())).toBeUndefined();
    expect(storage.set).not.toHaveBeenCalled();
  });
});

describe("forgetTab (FR-7)", () => {
  it("should delete a closed tab's settings", async () => {
    const storage = fakeStorage();
    storage.items.set("tab:8", status.settings);
    await forgetTab(storage, 8, newLog());
    expect(storage.items.has("tab:8")).toBe(false);
  });

  it("should log a failed delete", async () => {
    const storage = fakeStorage();
    storage.remove.mockRejectedValueOnce(new Error("x"));
    const log = newLog();
    await forgetTab(storage, 8, log);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("installPanelBehavior", () => {
  it("should open the panel from the toolbar icon", async () => {
    const sidePanel = { setPanelBehavior: vi.fn(() => Promise.resolve()) };
    await installPanelBehavior(sidePanel, newLog());
    expect(sidePanel.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
  });

  it("should log a failure", async () => {
    const log = newLog();
    await installPanelBehavior(
      { setPanelBehavior: () => Promise.reject(new Error("old chrome")) },
      log,
    );
    expect(log.error).toHaveBeenCalled();
  });
});
