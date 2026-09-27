import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortable,
  abortError,
  isAbortError,
  progressReporter,
  throwIfAborted,
  withTimeout,
} from "./progress";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("progressReporter", () => {
  it("reports increasing integers within 0..100", () => {
    const seen: number[] = [];
    const report = progressReporter((p) => seen.push(p));
    for (const p of [-5, 0, 0.9, 10.7, 10.2, 9, 55, Number.NaN, 150, 100]) {
      report(p);
    }
    expect(seen).toEqual([0, 10, 55, 100]);
  });

  it("is a no-op without a callback", () => {
    expect(() => {
      progressReporter()(50);
    }).not.toThrow();
  });

  it("logs a throwing callback instead of propagating", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const report = progressReporter(() => {
      throw new Error("ui bug");
    });
    expect(() => {
      report(10);
    }).not.toThrow();
    expect(error).toHaveBeenCalled();
  });
});

describe("abort helpers", () => {
  it("abortError is a DOMException named AbortError", () => {
    const err = abortError("gone");
    expect(err.name).toBe("AbortError");
    expect(err.message).toBe("gone");
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
  });

  it("throwIfAborted throws only once aborted", () => {
    const c = new AbortController();
    expect(() => {
      throwIfAborted(c.signal);
    }).not.toThrow();
    c.abort();
    expect(() => {
      throwIfAborted(c.signal);
    }).toThrow(expect.objectContaining({ name: "AbortError" }) as Error);
  });

  it("abortable resolves and rejects like the wrapped promise", async () => {
    const c = new AbortController();
    await expect(abortable(Promise.resolve(3), c.signal)).resolves.toBe(3);
    await expect(
      abortable(Promise.reject(new Error("bad")), c.signal),
    ).rejects.toThrow("bad");
    await expect(
      abortable(Promise.reject(new Error("x")), c.signal),
    ).rejects.toBeInstanceOf(Error);
  });

  it("abortable wraps non-Error rejections", async () => {
    const c = new AbortController();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(abortable(Promise.reject("nope"), c.signal)).rejects.toThrow(
      "nope",
    );
  });

  it("abortable rejects as soon as the signal aborts", async () => {
    const c = new AbortController();
    const pending = abortable(new Promise(() => undefined), c.signal);
    c.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("abortable rejects at once for an already aborted signal", async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      abortable(Promise.reject(new Error("ignored")), c.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("settles like the promise when it's in time", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => new Error("late"));
    await expect(withTimeout(Promise.resolve(7), 100, onTimeout)).resolves.toBe(
      7,
    );
    const boom = new Error("boom");
    await expect(
      withTimeout(Promise.reject(boom), 100, onTimeout),
    ).rejects.toBe(boom);
    await expect(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      withTimeout(Promise.reject("nope"), 100, onTimeout),
    ).rejects.toThrow("nope");
    vi.advanceTimersByTime(1000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("rejects with onTimeout() once the time is up, and hands a late value to onLate", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const onLate = vi.fn();
    const result = withTimeout(
      pending.promise,
      100,
      () => new Error("too slow"),
      onLate,
    );
    const settled = expect(result).rejects.toThrow("too slow");
    vi.advanceTimersByTime(99);
    await Promise.resolve();
    vi.advanceTimersByTime(1);
    await settled;
    pending.resolve("late value");
    await Promise.resolve();
    await Promise.resolve();
    expect(onLate).toHaveBeenCalledWith("late value");
  });

  it("ignores a late value by default and a late rejection always", async () => {
    vi.useFakeTimers();
    const lateValue = deferred<number>();
    const lateError = deferred<number>();
    const a = withTimeout(lateValue.promise, 10, () => new Error("a"));
    const b = withTimeout(lateError.promise, 10, () => new Error("b"));
    const settledA = expect(a).rejects.toThrow("a");
    const settledB = expect(b).rejects.toThrow("b");
    vi.advanceTimersByTime(10);
    await settledA;
    await settledB;
    lateValue.resolve(1);
    lateError.reject(new Error("ignored"));
    await Promise.resolve();
  });
});
