import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProgressStatus } from "./ProgressStatus";

describe("ProgressStatus", () => {
  it("announces the named stage politely and shows pct when known", () => {
    render(
      <ProgressStatus
        phase="waiting"
        source="url"
        uploadPct={null}
        stage="fetching"
        pct={42}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Fetching audio…");
    const bar = screen.getByRole("progressbar", { name: "Fetching audio…" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("Fetch audio")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("is indeterminate without pct and marks earlier steps done", () => {
    render(
      <ProgressStatus
        phase="waiting"
        source="upload"
        uploadPct={null}
        stage="processing"
        pct={null}
        onCancel={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-valuetext", "In progress");
    expect(screen.getByText("Upload")).toHaveClass("is-done");
    expect(screen.getByText("Process")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Ready to play")).not.toHaveClass("is-done");
  });

  it("shows upload progress and can be cancelled", () => {
    const onCancel = vi.fn();
    render(
      <ProgressStatus
        phase="submitting"
        source="upload"
        uploadPct={73.4}
        stage={null}
        pct={null}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Uploading…");
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "73",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
