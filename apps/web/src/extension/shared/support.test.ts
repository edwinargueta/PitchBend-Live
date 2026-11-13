// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { describe, expect, it, vi } from "vitest";
import { chromeGlobal } from "./chromePorts";
import { createLogger, LOG_PREFIX } from "./log";

describe("createLogger", () => {
  it("should prefix warnings and errors and pass the cause along", () => {
    const sink = { warn: vi.fn(), error: vi.fn() };
    const logger = createLogger(sink);
    const cause = new Error("boom");
    logger.warn("careful");
    logger.error("failed", cause);
    expect(sink.warn).toHaveBeenCalledWith(LOG_PREFIX, "careful");
    expect(sink.error).toHaveBeenCalledWith(LOG_PREFIX, "failed", cause);
  });

  it("should default to the console", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    createLogger().warn("hi");
    expect(spy).toHaveBeenCalledWith(LOG_PREFIX, "hi");
    spy.mockRestore();
  });
});

describe("chromeGlobal", () => {
  it("should return the chrome object from the scope", () => {
    const chrome = { runtime: { id: "abc" } };
    expect(chromeGlobal({ chrome })).toBe(chrome);
  });

  it("should throw outside an extension", () => {
    expect(() => chromeGlobal({})).toThrow(/isn't available/);
    expect(() => chromeGlobal({ chrome: null })).toThrow(/isn't available/);
    expect(() => chromeGlobal()).toThrow(/isn't available/);
  });
});
