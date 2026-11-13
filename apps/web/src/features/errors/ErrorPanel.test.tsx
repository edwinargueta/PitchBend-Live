import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorCode } from "../../lib/types";
import { ErrorPanel, EXTENSION_HINT } from "./ErrorPanel";

vi.mock(
  "../../lib/errors",
  async () => (await import("../__tests__/fakeLib")).fakeErrors,
);

function setup(
  code: ErrorCode,
  extra: { retryAfterS?: number; retry?: boolean } = {},
) {
  const handlers = {
    onUploadInstead: vi.fn(),
    onRetry: vi.fn(),
    onStartOver: vi.fn(),
  };
  render(
    <ErrorPanel
      error={{ code, message: "server says", retryAfterS: extra.retryAfterS }}
      onUploadInstead={handlers.onUploadInstead}
      onRetry={extra.retry === false ? undefined : handlers.onRetry}
      onStartOver={handlers.onStartOver}
    />,
  );
  return handlers;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ErrorPanel", () => {
  const codes: ErrorCode[] = [
    "INVALID_URL",
    "UNSUPPORTED_FILE",
    "FILE_TOO_LARGE",
    "VIDEO_TOO_LONG",
    "LIVESTREAM",
    "SOURCE_UNAVAILABLE",
    "SOURCE_BLOCKED",
    "RATE_LIMITED",
    "KEY_DETECTION_FAILED",
    "NOT_FOUND",
    "INTERNAL",
  ];

  it.each(codes)("shows describeError copy for %s as an alert", (code) => {
    setup(code);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(`Title ${code}`);
    expect(alert).toHaveTextContent(`Message ${code}`);
    expect(
      screen.getByRole("heading", { name: `Title ${code}` }),
    ).toBeInTheDocument();
  });

  it("SOURCE_BLOCKED prominently suggests uploading", () => {
    const h = setup("SOURCE_BLOCKED");
    const upload = screen.getByRole("button", {
      name: "Upload the file instead",
    });
    expect(upload).toHaveClass("btn--primary");
    fireEvent.click(upload);
    expect(h.onUploadInstead).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /Try again/ }),
    ).not.toBeInTheDocument();
  });

  it("SOURCE_BLOCKED also mentions the Chrome extension, after the upload action (AC-14)", () => {
    setup("SOURCE_BLOCKED");
    const hint = screen.getByText(EXTENSION_HINT);
    expect(hint).toHaveTextContent("Chrome extension");
    const upload = screen.getByRole("button", {
      name: "Upload the file instead",
    });
    expect(upload).toHaveClass("btn--primary");
    expect(
      upload.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("alert")).not.toHaveTextContent("Chrome extension");
  });

  it.each(codes.filter((code) => code !== "SOURCE_BLOCKED"))(
    "%s doesn't show the extension hint (AC-14)",
    (code) => {
      setup(code);
      expect(screen.queryByText(EXTENSION_HINT)).not.toBeInTheDocument();
    },
  );

  it("RATE_LIMITED shows the retry time and enables retry when it's up", () => {
    vi.useFakeTimers();
    const h = setup("RATE_LIMITED", { retryAfterS: 65 });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Message RATE_LIMITED 65",
    );
    const retry = screen.getByRole("button", { name: "Try again in 1:05" });
    expect(retry).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    const ready = screen.getByRole("button", { name: "Try again" });
    expect(ready).toBeEnabled();
    fireEvent.click(ready);
    expect(h.onRetry).toHaveBeenCalled();
  });

  it("RATE_LIMITED without a retry time can be retried right away", () => {
    setup("RATE_LIMITED");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("INTERNAL offers a retry; input errors don't", () => {
    setup("INTERNAL");
    expect(screen.getByRole("button", { name: "Try again" })).toHaveClass(
      "btn--primary",
    );
  });

  it("offers no retry without a retry handler", () => {
    setup("INTERNAL", { retry: false });
    expect(
      screen.queryByRole("button", { name: /Try again/ }),
    ).not.toBeInTheDocument();
    setup("INVALID_URL");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("NOT_FOUND offers start over", () => {
    const h = setup("NOT_FOUND");
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(h.onStartOver).toHaveBeenCalled();
  });
});
