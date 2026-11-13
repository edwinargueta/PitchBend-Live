# 0009. Transpose YouTube playback in a Chrome extension
Date: 2026-11-12
Status: Accepted (owner, 2026-11-12). Supersedes [ADR 0008](0008-youtube-relay-through-home-raspberry-pi.md) and the desktop-shell spike (branch `spike/desktop-shell`, whose planned ADR is replaced by this one).

## Context
- **The server can't fetch YouTube.** Since the first deploy (2026-09-27), every YouTube link fails with `SOURCE_BLOCKED`, because YouTube bot-checks the Oracle datacenter IP (ADR 0008, §14).
- **Earlier fixes all still fetch, and each was hard to close:**
  - ADR 0008 (Raspberry Pi relay): proposed, not built. It needs a home device, a tunnel, a daily cap, and sign-off on CLAUDE.md §4, §5 and §7.
  - The desktop-shell spike (Tauri + local yt-dlp): no GO is reachable. The home fetch was never tested, Gatekeeper wasn't checked on a clean Mac, nothing was built for Windows, and the spike shipped yt-dlp and an updater.
- **The owner's real need is to transpose the song they're watching.** For that, nothing needs fetching: the audio is already playing in their browser.
- **Chrome Web Store policy** says: "Do not encourage, facilitate, or enable the unauthorized access, download, or streaming of copyrighted content or media." Extensions with YouTube download features have been rejected under that rule ("Blue Zinc", March 2026). So any download of YouTube audio is out, whatever the technique.

## Decision
1. **A Manifest V3 Chrome extension transposes YouTube playback live, in the user's tab.**
   - A content script on `www.youtube.com` and `music.youtube.com` routes the main `<video>` element through `createMediaElementSource`, into Signalsmith Stretch (MIT) in an AudioWorklet in live-input mode, and out to the speakers.
   - It changes pitch only. The video element keeps its own clock and rate, so tempo is untouched.
2. **Nothing is downloaded, recorded, or sent anywhere** (owner's Option A).
   - The extension makes no network requests and has no `downloads` or `tabCapture` permission.
   - Exporting with the transpose applied stays in the web app, for files the user uploads.
3. **The web app keeps uploads, key detection, and WAV export.**
   - Its YouTube input stays unchanged (no §6.4 or §6.6 change).
   - `SOURCE_BLOCKED` keeps its prominent upload action and adds a pointer to the extension.
4. **Where the code lives:** inside the existing `apps/web` package, so it shares one lockfile, one Docker dev image, and one `make check`.
   - Source in `apps/web/src/extension/`.
   - Build config in `apps/web/vite.extension.config.ts`.
   - Output in `apps/web/dist-extension/` (git- and docker-ignored), which is what `chrome://extensions → Load unpacked` points at.
   - E2E tests in `apps/web/e2e/extension/`.
   - It reuses `src/audio/pitch.ts`, `src/audio/ramp.ts`, `src/lib/music.ts`, and the `KeyDial` component read-only. This is a new workstream (**D = `apps/web/src/extension/`**), and it changes no shared code.
5. **Worklet loading** (spike E1, 2026-11-12, against a fixture page sending YouTube's real CSP):
   - `SignalsmithStretch.mjs` ships unchanged as a web-accessible resource. The content script imports it dynamically and sets `moduleUrl` to the same file; in a worklet scope the file registers its own processor.
   - The library's default Blob-URL worklet is refused by YouTube's CSP. The packaged file loads, its WASM compiles (YouTube allows `'unsafe-eval'`), and +12 on a 440 Hz tone measured 882 Hz.
6. **Latency budget:** the shifter runs `{ blockMs: 60, intervalMs: 15 }`, a measured 60 ms, against the default preset's 120 ms. That keeps the added delay (shifter + `baseLatency`) at or under the owner's 80 ms limit.
7. **Permissions** are exactly `sidePanel` and `storage`, with host access to the two YouTube origins.
   - Per-tab settings live in `chrome.storage.session` (memory only) and are deleted when the tab closes.
   - No telemetry, no cookies, no remote code.
8. **Distribution:** for now the owner loads it unpacked. It's built to be Chrome Web Store-compatible. Publishing (a one-time registration fee) is a later decision for the owner (CLAUDE.md §2, cost).

## Alternatives considered
- **`tabCapture` + offscreen document.** This runs outside the page's CSP and works on any site. But it needs a click per tab, shows the "sharing this tab" indicator, adds latency, and needs the broader `tabCapture` permission. It's kept as a fallback in case YouTube's CSP ever blocks the packaged worklet.
- **Record or download the transposed audio** (Option B: real-time capture; Option C: fetch the stream and render offline). Rejected: both are downloading YouTube content, against the store policy, YouTube's ToS and CLAUDE.md §7.
- **ADR 0008's Pi relay and the desktop shell.** Superseded, because the extension needs no fetch at all.
- **A separate `apps/extension` package.** That would need a second Docker image, a pnpm workspace, and new Compose services and CI build steps just to share three modules. Rejected for the blast radius on shared infra.

## Consequences
- **§4's core principle is narrowed:** for YouTube in the extension, the server fetches and analyzes nothing. The rest is unchanged: uploads are still fetched and analyzed once, and live pitch shifting stays client-side (D1).
- **Key detection for YouTube becomes manual in v1** (the user picks the original key). A progressive in-browser estimate is v2. Cents fine-tuning is deferred.
- **New fragility: YouTube's DOM and CSP.** The video lookup falls back from `#movie_player video.html5-main-video` to the largest `<video>`. Any start failure leaves the audio unmodified (the graph connects its dry path before the shifter starts, and it never takes over a suspended context), and the side panel says why.
- **Ads are transposed too.** There's no ad detection, because it would depend on YouTube's ad markup.
- **The extension isn't in any numbered phase.** It runs alongside Phase 1, at the owner's request. Phase 1's definition of done (deploying to the cluster) is unchanged.
- **Testing:** unit tests run under the existing Vitest thresholds. A Playwright e2e (`make test-extension`, CI job `extension-browser`) loads the unpacked build in Chromium, against a fixture served as `www.youtube.com` with YouTube's CSP. A manual checklist covers real YouTube (soak, ads, macOS Chrome): `apps/web/src/extension/README.md`.
- **ToS posture:** the extension changes how the user's own playback sounds and keeps nothing. CLAUDE.md §7's retention, naming, and no-library rules are untouched, because no media is stored.
