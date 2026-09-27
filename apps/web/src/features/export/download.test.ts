import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBlob } from "./download";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("downloadBlob", () => {
  it("clicks a temporary download link, then revokes the URL", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:fake");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const blob = new Blob(["x"]);
    downloadBlob(blob, "Song (A major, +2).wav");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    const clicked = click.mock.contexts[0] as HTMLAnchorElement | undefined;
    expect(clicked?.download).toBe("Song (A major, +2).wav");
    expect(clicked?.getAttribute("href")).toBe("blob:fake");
    expect(clicked?.isConnected).toBe(false); // removed again
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });
});
