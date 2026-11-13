// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOM_DEBOUNCE_MS,
  findMainVideo,
  VideoTracker,
  videoKeyOf,
} from "./videoTracker";

function sized(width: number, height: number): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "clientWidth", { value: width });
  Object.defineProperty(video, "clientHeight", { value: height });
  return video;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("findMainVideo", () => {
  it("should prefer the watch-page player", () => {
    const other = document.createElement("video");
    other.className = "html5-main-video";
    const player = document.createElement("div");
    player.id = "movie_player";
    const main = document.createElement("video");
    main.className = "video-stream html5-main-video";
    player.append(main);
    document.body.append(other, player);
    expect(findMainVideo(document)).toBe(main);
  });

  it("should fall back to any YouTube player video (e.g. YouTube Music)", () => {
    const main = document.createElement("video");
    main.className = "html5-main-video";
    document.body.append(sized(900, 500), main);
    expect(findMainVideo(document)).toBe(main);
  });

  it("should fall back to the largest video", () => {
    const small = sized(100, 50);
    const large = sized(640, 360);
    document.body.append(small, large, sized(640, 100));
    expect(findMainVideo(document)).toBe(large);
  });

  it("should return null without any video", () => {
    expect(findMainVideo(document)).toBeNull();
  });
});

describe("videoKeyOf", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/shorts/abcdefghijk?feature=share", "abcdefghijk"],
    ["https://www.youtube.com/", null],
    ["https://www.youtube.com/shorts/short", null],
    ["not a url", null],
  ])("%s → %s", (href, key) => {
    expect(videoKeyOf(href)).toBe(key);
  });
});

describe("VideoTracker", () => {
  let href = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
  const events = { onElement: vi.fn(), onVideoChanged: vi.fn() };
  let tracker: VideoTracker;

  function mainVideo(): HTMLVideoElement {
    const video = document.createElement("video");
    video.className = "html5-main-video";
    document.body.append(video);
    return video;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    href = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
    events.onElement.mockClear();
    events.onVideoChanged.mockClear();
    tracker = new VideoTracker(document, () => href, events);
  });

  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
  });

  it("should report the current element once on start", () => {
    const video = mainVideo();
    tracker.start();
    tracker.start(); // idempotent
    expect(events.onElement).toHaveBeenCalledTimes(1);
    expect(events.onElement).toHaveBeenCalledWith(video);
    expect(tracker.element).toBe(video);
    expect(events.onVideoChanged).not.toHaveBeenCalled();
  });

  it("should report a new video on yt-navigate-finish (AC-8)", () => {
    mainVideo();
    tracker.start();
    href = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
    document.dispatchEvent(new Event("yt-navigate-finish"));
    expect(events.onVideoChanged).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("yt-navigate-finish"));
    expect(events.onVideoChanged).toHaveBeenCalledTimes(1);
  });

  it("should not report a new video for an ad in the same URL (FR-10)", () => {
    const video = mainVideo();
    tracker.start();
    video.dispatchEvent(new Event("loadstart"));
    expect(events.onVideoChanged).not.toHaveBeenCalled();
  });

  it("should notice a source change through loadstart", () => {
    const video = mainVideo();
    tracker.start();
    href = "https://www.youtube.com/watch?v=ccccccccccc";
    video.dispatchEvent(new Event("loadstart"));
    expect(events.onVideoChanged).toHaveBeenCalledTimes(1);
  });

  it("should notice a replaced element after the DOM settles", async () => {
    const first = mainVideo();
    tracker.start();
    first.remove();
    const second = mainVideo();
    await vi.advanceTimersByTimeAsync(DOM_DEBOUNCE_MS + 10);
    expect(events.onElement).toHaveBeenLastCalledWith(second);
    second.remove();
    await vi.advanceTimersByTimeAsync(DOM_DEBOUNCE_MS + 10);
    expect(events.onElement).toHaveBeenLastCalledWith(null);
  });

  it("should stop listening after stop()", async () => {
    mainVideo();
    tracker.start();
    tracker.stop();
    href = "https://www.youtube.com/watch?v=ddddddddddd";
    document.dispatchEvent(new Event("yt-navigate-finish"));
    mainVideo();
    await vi.advanceTimersByTimeAsync(DOM_DEBOUNCE_MS + 10);
    expect(events.onVideoChanged).not.toHaveBeenCalled();
    expect(events.onElement).toHaveBeenCalledTimes(1);
  });
});
