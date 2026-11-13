// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Finds YouTube's main <video> and notices when it changes (FR-1, FR-6, AC-8).
//
// YouTube is a single-page app: moving to the next video keeps the document,
// usually keeps the same <video> element, and swaps its source. So "a new
// video" is detected from the URL's video ID (in memory only, never stored),
// re-checked on YouTube's `yt-navigate-finish` event, on any media `loadstart`
// and, debounced, on DOM changes (which also catch a replaced element). An ad
// plays in the same element under the same URL, so it isn't a new video
// (FR-10).

/** Most specific first: the watch-page player, then any YouTube player. */
export const MAIN_VIDEO_SELECTORS: readonly string[] = [
  "#movie_player video.html5-main-video",
  "video.html5-main-video",
];

export const DOM_DEBOUNCE_MS = 250;

/** YouTube's main video, or else the largest <video> on the page. */
export function findMainVideo(doc: Document): HTMLVideoElement | null {
  for (const selector of MAIN_VIDEO_SELECTORS) {
    const match = doc.querySelector<HTMLVideoElement>(selector);
    if (match) return match;
  }
  let best: HTMLVideoElement | null = null;
  let bestArea = -1;
  for (const video of doc.querySelectorAll("video")) {
    const area = video.clientWidth * video.clientHeight;
    if (area > bestArea) {
      best = video;
      bestArea = area;
    }
  }
  return best;
}

const SHORTS_PATH = /^\/shorts\/([A-Za-z0-9_-]{11})/;

/** The video ID in a watch (`?v=`) or Shorts URL, else null. */
export function videoKeyOf(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const v = url.searchParams.get("v");
  if (v) return v;
  return SHORTS_PATH.exec(url.pathname)?.[1] ?? null;
}

export interface TrackerEvents {
  /** The main video element changed (null: there is none right now). */
  onElement(element: HTMLVideoElement | null): void;
  /** The page moved to a different video (or away from one). */
  onVideoChanged(): void;
}

export class VideoTracker {
  private readonly doc: Document;
  private readonly href: () => string;
  private readonly events: TrackerEvents;
  private readonly debounceMs: number;
  private current: HTMLVideoElement | null = null;
  private key: string | null = null;
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly check = (): void => {
    this.refresh();
  };
  private readonly debounced = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.check, this.debounceMs);
  };

  constructor(
    doc: Document,
    href: () => string,
    events: TrackerEvents,
    debounceMs = DOM_DEBOUNCE_MS,
  ) {
    this.doc = doc;
    this.href = href;
    this.events = events;
    this.debounceMs = debounceMs;
  }

  get element(): HTMLVideoElement | null {
    return this.current;
  }

  /** Begin watching; reports the current element once. */
  start(): void {
    if (this.observer) return;
    this.key = videoKeyOf(this.href());
    this.current = findMainVideo(this.doc);
    this.doc.addEventListener("yt-navigate-finish", this.check);
    this.doc.addEventListener("loadstart", this.check, true);
    this.observer = new MutationObserver(this.debounced);
    this.observer.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
    });
    this.events.onElement(this.current);
  }

  stop(): void {
    this.doc.removeEventListener("yt-navigate-finish", this.check);
    this.doc.removeEventListener("loadstart", this.check, true);
    this.observer?.disconnect();
    this.observer = null;
    clearTimeout(this.timer);
  }

  /** Re-read the element and the video ID, reporting any change. */
  refresh(): void {
    const element = findMainVideo(this.doc);
    if (element !== this.current) {
      this.current = element;
      this.events.onElement(element);
    }
    const key = videoKeyOf(this.href());
    if (key !== this.key) {
      this.key = key;
      this.events.onVideoChanged();
    }
  }
}
