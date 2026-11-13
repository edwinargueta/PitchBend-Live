// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { describe, expect, it, vi } from "vitest";
import type { TabInfo } from "../shared/chromePorts";
import type { TabStatus } from "../shared/protocol";
import { DEFAULT_SETTINGS } from "../shared/tabState";
import { fakePanelChrome } from "../testing/fakeChrome";
import { PanelStore, tabIdOverride } from "./panelStore";

const WATCH = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const status = (semitones = 0): TabStatus => ({
  state: "idle",
  settings: { ...DEFAULT_SETTINGS, semitones },
  site: "youtube",
  shifterMs: null,
  addedMs: null,
  error: null,
  appliedAt: null,
  sentAt: null,
});

function connect(
  tab: TabInfo | null = { id: 4, url: WATCH },
  override: number | null = null,
) {
  const fake = fakePanelChrome(tab ?? undefined);
  fake.sendMessage.mockImplementation((_id, message) =>
    Promise.resolve(
      (message as { type: string }).type === "getStatus" ? status() : status(5),
    ),
  );
  const store = new PanelStore(fake.chrome, override, () => 77);
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  return { ...fake, store, listener, unsubscribe };
}

const settled = (store: PanelStore, kind: string) =>
  vi.waitFor(() => {
    expect(store.getView().kind).toBe(kind);
  });

describe("tabIdOverride", () => {
  it.each([
    ["?tabId=12", 12],
    ["?tabId=abc", null],
    ["?tabId=-1", null],
    ["", null],
  ])("%s → %s", (search, id) => {
    expect(tabIdOverride(search)).toBe(id);
  });
});

describe("PanelStore", () => {
  it("should start loading and connect to the active YouTube tab", async () => {
    const fake = fakePanelChrome({ id: 4, url: WATCH });
    fake.sendMessage.mockResolvedValue(status());
    const store = new PanelStore(fake.chrome, null, () => 1);
    expect(store.getView()).toEqual({ kind: "loading" });
    const listener = vi.fn();
    store.subscribe(listener);
    await settled(store, "ready");
    expect(store.getView()).toEqual({
      kind: "ready",
      tabId: 4,
      status: status(),
    });
    expect(fake.sendMessage).toHaveBeenCalledWith(4, { type: "getStatus" });
    expect(fake.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(listener).toHaveBeenCalled();
  });

  it("should use the ?tabId= override", async () => {
    const { store, get } = connect({ id: 9, url: WATCH }, 9);
    await settled(store, "ready");
    expect(get).toHaveBeenCalledWith(9);
  });

  it("should treat a closed override tab as not YouTube", async () => {
    const { store } = connect({ id: 9, url: WATCH }, 10);
    await settled(store, "not-youtube");
  });

  it.each<[string, TabInfo | null]>([
    ["a non-YouTube tab", { id: 4, url: "https://example.com/" }],
    ["a tab without an id", { url: WATCH }],
    ["no tab at all", null],
  ])("should report not-youtube for %s", async (_label, tab) => {
    const { store } = connect(tab);
    await settled(store, "not-youtube");
  });

  it("should ask for a reload when the tab has no content script", async () => {
    const fake = fakePanelChrome({ id: 4, url: WATCH });
    const store = new PanelStore(fake.chrome, null, () => 1);
    store.subscribe(vi.fn());
    await settled(store, "no-receiver");
    fake.sendMessage.mockResolvedValueOnce({ not: "a status" });
    store.send({ type: "reset" });
    await vi.waitFor(() => {
      expect(fake.sendMessage).toHaveBeenCalledTimes(2);
    });
    expect(store.getView()).toEqual({ kind: "no-receiver", tabId: 4 });
  });

  it("should stamp and send commands, then show the reply (AC-2)", async () => {
    const { store, sendMessage } = connect();
    await settled(store, "ready");
    store.send({ type: "set", semitones: 5 });
    await vi.waitFor(() => {
      expect(store.getView()).toMatchObject({
        status: { settings: { semitones: 5 } },
      });
    });
    expect(sendMessage).toHaveBeenLastCalledWith(4, {
      type: "set",
      semitones: 5,
      sentAt: 77,
    });
    store.send({ type: "getStatus" });
    expect(sendMessage).toHaveBeenLastCalledWith(4, { type: "getStatus" });
  });

  it("should not send before a tab is known", () => {
    const fake = fakePanelChrome(undefined);
    const store = new PanelStore(fake.chrome, null, () => 1);
    store.send({ type: "reset" });
    expect(fake.sendMessage).not.toHaveBeenCalled();
  });

  it("should drop a stale reply that arrives after a newer one", async () => {
    const { store, sendMessage } = connect();
    await settled(store, "ready");
    let resolveSlow: (value: unknown) => void = () => undefined;
    sendMessage.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSlow = resolve)),
    );
    sendMessage.mockImplementationOnce(() => Promise.resolve(status(3)));
    store.send({ type: "set", semitones: 1 }); // slow
    store.send({ type: "set", semitones: 3 }); // fast
    await vi.waitFor(() => {
      expect(store.getView()).toMatchObject({
        status: { settings: { semitones: 3 } },
      });
    });
    resolveSlow(status(1));
    await Promise.resolve();
    expect(store.getView()).toMatchObject({
      status: { settings: { semitones: 3 } },
    });
  });

  it("should follow status pushes from its own tab only", async () => {
    const { store, onMessage } = connect();
    await settled(store, "ready");
    onMessage.emit(
      { type: "status", status: status(7) },
      { tab: { id: 99 } },
      vi.fn(),
    );
    onMessage.emit({ type: "other" }, { tab: { id: 4 } }, vi.fn());
    expect(store.getView()).toMatchObject({
      status: { settings: { semitones: 0 } },
    });
    onMessage.emit(
      { type: "status", status: status(7) },
      { tab: { id: 4 } },
      vi.fn(),
    );
    expect(store.getView()).toMatchObject({
      status: { settings: { semitones: 7 } },
    });
  });

  it("should ignore status pushes before a tab is known", () => {
    const fake = fakePanelChrome(undefined);
    const store = new PanelStore(fake.chrome, null, () => 1);
    store.subscribe(vi.fn());
    fake.onMessage.emit(
      { type: "status", status: status(2) },
      { tab: { id: 4 } },
      vi.fn(),
    );
    expect(store.getView().kind).not.toBe("ready");
  });

  it("should refresh on tab activation and on its tab's navigation", async () => {
    const { store, onActivated, onUpdated, state, query } = connect();
    await settled(store, "ready");
    state.active = { id: 5, url: "https://example.com/" };
    onActivated.emit({ tabId: 5, windowId: 1 });
    await settled(store, "not-youtube");
    const calls = query.mock.calls.length;
    onUpdated.emit(5, { status: "loading" }); // not a finished navigation
    expect(query.mock.calls.length).toBe(calls);
    state.active = { id: 5, url: WATCH };
    onUpdated.emit(5, { url: WATCH });
    await vi.waitFor(() => {
      expect(store.getView()).toMatchObject({ kind: "ready", tabId: 5 });
    });
    onUpdated.emit(6, { status: "complete" }); // another tab
    expect(query.mock.calls.length).toBe(calls + 1);
    onUpdated.emit(5, { status: "complete" });
    expect(query.mock.calls.length).toBe(calls + 2);
  });

  it("should ignore activation when pinned to a tab, and stop when unsubscribed", async () => {
    const { store, onActivated, onMessage, get, unsubscribe } = connect(
      { id: 9, url: WATCH },
      9,
    );
    await settled(store, "ready");
    onActivated.emit({ tabId: 3, windowId: 1 });
    expect(get).toHaveBeenCalledTimes(1);
    const second = store.subscribe(vi.fn());
    unsubscribe();
    expect(onMessage.size).toBe(1); // still one subscriber
    second();
    expect(onMessage.size).toBe(0);
  });
});
