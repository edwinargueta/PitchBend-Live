/**
 * Wraps a 0..100 progress callback so it only ever sees integers that go up:
 * values are floored, clamped, and repeats or regressions are dropped. A
 * throwing callback is logged; it never aborts the load or render it watches.
 */
export function progressReporter(
  cb?: (pct: number) => void,
): (pct: number) => void {
  let last = -1;
  return (pct) => {
    if (!cb || Number.isNaN(pct)) return;
    const value = Math.min(100, Math.max(0, Math.floor(pct)));
    if (value <= last) return;
    last = value;
    try {
      cb(value);
    } catch (err) {
      console.error("[audio] progress callback threw", err);
    }
  };
}

export function abortError(
  message = "The operation was aborted",
): DOMException {
  return new DOMException(message, "AbortError");
}

/** Like AbortSignal.throwIfAborted (missing before Safari 15.4). */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Settles like `promise`, or rejects with an AbortError as soon as `signal` aborts. */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(noop);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Settles like `promise`, or rejects with `onTimeout()` if it hasn't settled
 * after `ms`. A value that arrives after the timeout goes to `onLate` (e.g. to
 * release it), since nobody else will see it.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
  onLate: (value: T) => void = noop,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(onTimeout());
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) onLate(value);
        else resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function noop(): void {
  // Intentionally empty.
}
