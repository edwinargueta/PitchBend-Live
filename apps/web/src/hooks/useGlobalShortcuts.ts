// Page-wide player shortcuts (§10 C4): ←/→ = ±1 semitone, 0 = reset, Space = play/pause.
// They never fire while the user is typing, and they leave native keyboard
// behaviour alone (Space on a button activates it; arrows on a range input seek).
import { useEffect, useRef } from "react";

export interface ShortcutHandlers {
  onStep: (delta: 1 | -1) => void;
  onReset: () => void;
  onTogglePlay: () => void;
}

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "email",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** True for anything the user can type into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
    return true;
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type);
  }
  return false;
}

/** Elements where Space has a native action (activate/toggle). */
function spaceIsNative(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest(
      'button, a[href], summary, input[type="checkbox"], input[type="radio"], input[type="file"], [role="button"], [role="switch"], [role="checkbox"]',
    ) !== null
  );
}

/** Elements where arrow keys have a native action (range inputs, sliders). */
function arrowsAreNative(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest(
      'input[type="range"], [role="slider"], [role="radiogroup"]',
    ) !== null
  );
}

export function useGlobalShortcuts(
  handlers: ShortcutHandlers,
  enabled = true,
): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const h = handlersRef.current;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight":
          if (arrowsAreNative(e.target)) return;
          e.preventDefault();
          h.onStep(e.key === "ArrowRight" ? 1 : -1);
          return;
        case "0":
          e.preventDefault();
          h.onReset();
          return;
        case " ":
          if (spaceIsNative(e.target)) return;
          e.preventDefault(); // don't scroll the page
          if (!e.repeat) h.onTogglePlay();
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled]);
}
