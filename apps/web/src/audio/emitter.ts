export type Listener = (...args: unknown[]) => void;

/** Minimal event emitter. A throwing listener is logged and never breaks the others. */
export class Emitter<E extends string> {
  private readonly listeners = new Map<E, Set<{ cb: Listener }>>();

  /** Subscribe; returns an idempotent unsubscribe function. */
  on(event: E, cb: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    // A fresh entry per call, so subscribing the same callback twice needs two unsubscribes.
    const entry = { cb };
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  emit(event: E, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const { cb } of [...set]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[audio] "${event}" listener threw`, err);
      }
    }
  }

  listenerCount(event: E): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
