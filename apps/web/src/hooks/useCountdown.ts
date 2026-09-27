import { useEffect, useState } from "react";

/** Whole seconds left of `totalSeconds`, ticking once a second down to 0. */
export function useCountdown(totalSeconds: number | null): number {
  const initial =
    totalSeconds !== null && totalSeconds > 0 ? Math.ceil(totalSeconds) : 0;
  const [remaining, setRemaining] = useState(initial);
  const [prevTotal, setPrevTotal] = useState(totalSeconds);

  if (prevTotal !== totalSeconds) {
    setPrevTotal(totalSeconds);
    setRemaining(initial);
  }

  useEffect(() => {
    if (initial === 0) return;
    const deadline = Date.now() + initial * 1000;
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) window.clearInterval(id);
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [initial]);

  return remaining;
}
