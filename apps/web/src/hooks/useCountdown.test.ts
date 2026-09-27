import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCountdown } from "./useCountdown";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useCountdown", () => {
  it("counts whole seconds down to zero", () => {
    const { result } = renderHook(() => useCountdown(2.2));
    expect(result.current).toBe(3);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(2);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(0);
  });

  it("is zero for null, zero or negative input", () => {
    expect(renderHook(() => useCountdown(null)).result.current).toBe(0);
    expect(renderHook(() => useCountdown(0)).result.current).toBe(0);
    expect(renderHook(() => useCountdown(-4)).result.current).toBe(0);
  });

  it("restarts when the total changes", () => {
    const { result, rerender } = renderHook<number, { s: number | null }>(
      ({ s }) => useCountdown(s),
      { initialProps: { s: 5 } },
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(3);
    rerender({ s: 10 });
    expect(result.current).toBe(10);
    rerender({ s: null });
    expect(result.current).toBe(0);
  });
});
