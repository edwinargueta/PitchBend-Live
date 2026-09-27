import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "./emitter";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Emitter", () => {
  it("delivers arguments to every listener of that event only", () => {
    const e = new Emitter<"a" | "b">();
    const a1 = vi.fn();
    const a2 = vi.fn();
    const b = vi.fn();
    e.on("a", a1);
    e.on("a", a2);
    e.on("b", b);
    e.emit("a", 1, "x");
    expect(a1).toHaveBeenCalledWith(1, "x");
    expect(a2).toHaveBeenCalledWith(1, "x");
    expect(b).not.toHaveBeenCalled();
  });

  it("ignores events nobody listens to", () => {
    const e = new Emitter<"a">();
    expect(() => {
      e.emit("a");
    }).not.toThrow();
    expect(e.listenerCount("a")).toBe(0);
  });

  it("unsubscribes idempotently, per subscription", () => {
    const e = new Emitter<"a">();
    const cb = vi.fn();
    const off1 = e.on("a", cb);
    const off2 = e.on("a", cb);
    expect(e.listenerCount("a")).toBe(2);
    off1();
    off1();
    e.emit("a");
    expect(cb).toHaveBeenCalledTimes(1);
    off2();
    e.emit("a");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(e.listenerCount("a")).toBe(0);
  });

  it("tolerates unsubscribing during emit", () => {
    const e = new Emitter<"a">();
    const later = vi.fn();
    const off = e.on("a", () => {
      off();
    });
    e.on("a", later);
    e.emit("a");
    e.emit("a");
    expect(later).toHaveBeenCalledTimes(2);
  });

  it("logs a throwing listener and still calls the rest", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const e = new Emitter<"a">();
    const after = vi.fn();
    e.on("a", () => {
      throw new Error("boom");
    });
    e.on("a", after);
    e.emit("a");
    expect(after).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"a"'),
      expect.any(Error),
    );
  });
});
