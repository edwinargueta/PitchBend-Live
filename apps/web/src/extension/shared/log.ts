// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// The extension's only logger: prefixed, local console only (no telemetry;
// spec NFR Observability). Never pass page data, URLs or titles to it.

export const LOG_PREFIX = "[PitchBend Live]";

export interface Logger {
  warn(message: string, cause?: unknown): void;
  error(message: string, cause?: unknown): void;
}

type Sink = Pick<Console, "warn" | "error">;

export function createLogger(sink: Sink = console): Logger {
  const args = (message: string, cause: unknown): unknown[] =>
    cause === undefined ? [LOG_PREFIX, message] : [LOG_PREFIX, message, cause];
  return {
    warn: (message, cause) => {
      sink.warn(...args(message, cause));
    },
    error: (message, cause) => {
      sink.error(...args(message, cause));
    },
  };
}

export const log: Logger = createLogger();
