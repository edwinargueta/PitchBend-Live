// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// A stand-in for a YouTube watch page, served by Playwright at the real
// YouTube origins so the extension's content script runs on it. It sends
// YouTube's own CSP (checked 2026-11-12: an allowlist policy, Trusted Types,
// and a nonce + strict-dynamic policy, all with 'unsafe-eval' and no blob:
// scripts), which is what decides whether the packaged worklet can load.
// Tones are generated in the page, so the suite needs no media files and
// never touches the network.

export const NONCE = "pbl-e2e-nonce";

export const YOUTUBE_CSP = [
  "script-src 'unsafe-eval' 'self' 'unsafe-inline' https://www.google.com https://apis.google.com https://ssl.gstatic.com https://www.gstatic.com https://*.youtube.com https://*.google.com https://*.gstatic.com https://youtube.com https://www.youtube.com https://google.com https://*.googleapis.com;report-uri https://csp.invalid/allowlist",
  "require-trusted-types-for 'script'",
  `base-uri 'self';object-src 'none';script-src 'report-sample' 'nonce-${NONCE}' 'unsafe-inline' 'strict-dynamic' https: http: 'unsafe-eval';report-uri https://csp.invalid/strict`,
].join(", ");

export const FIXTURE_HOSTS = ["www.youtube.com", "music.youtube.com"];

/**
 * True for a request that would leave the browser: any http(s)/ws(s) URL
 * the suite doesn't serve. The extension's own chrome-extension:// files and
 * the page's blob: tones never touch the network.
 */
export function isNetworkEscape(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return (
      ["http:", "https:", "ws:", "wss:"].includes(protocol) &&
      !isFixtureUrl(url)
    );
  } catch {
    return false;
  }
}

/** True for URLs the suite serves itself. */
export function isFixtureUrl(url: string): boolean {
  try {
    return FIXTURE_HOSTS.includes(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * The watch page. `?f=<Hz>` picks the tone. Buttons:
 *  #play  starts playback (and gives the page user activation);
 *  #next  in-page navigation to another video: pushState, a new source, then
 *         YouTube's `yt-navigate-finish` event (AC-8);
 *  #ad    an "ad": a new source under the same URL (FR-10).
 */
export const WATCH_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture watch page</title></head>
<body>
<div id="movie_player"><video class="video-stream html5-main-video"></video></div>
<button id="play">Play</button>
<button id="next">Next video</button>
<button id="ad">Ad</button>
<script nonce="${NONCE}">
function tone(freq, seconds, sampleRate) {
  const n = Math.round(seconds * sampleRate);
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * i / sampleRate) * 0.5 * 32767), true);
  return buffer;
}
const video = document.querySelector("video");
video.loop = true;
function load(freq) {
  video.src = URL.createObjectURL(new Blob([tone(freq, 20, 44100)], { type: "audio/wav" }));
}
load(Number(new URLSearchParams(location.search).get("f") || 440));
document.getElementById("play").addEventListener("click", () => { void video.play(); });
document.getElementById("next").addEventListener("click", () => {
  history.pushState(null, "", "/watch?v=bbbbbbbbbbb&f=660");
  load(660);
  void video.play();
  document.dispatchEvent(new Event("yt-navigate-finish"));
});
document.getElementById("ad").addEventListener("click", () => { load(550); void video.play(); });
</script>
</body>
</html>`;

/** Equal-tempered frequency `semitones` away from `base`. */
export function shifted(base: number, semitones: number): number {
  return base * 2 ** (semitones / 12);
}
