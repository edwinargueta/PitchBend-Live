# 0006. Phase 1 implementation notes
Date: 2026-09-26
Status: Accepted (amends ADR 0004 and ADR 0005 §4, §7, §12)

## Context
Phase 1 was built by five parallel workstreams against §6 and ADR 0005, then integrated and verified end to end:
- the Compose stack
- a Playwright happy path in Chromium
- the audio engine's specs on real Web Audio in Chromium, Firefox and WebKit
- the production image under production-like permissions

A few details went beyond or refined ADR 0005, and the integration made some choices of its own. They're recorded here so nothing changes silently.

## Decision

### Refinements to ADR 0005
1. **Dedup (§4):**
   - A track that's `ready` but whose ingest job is still **analyzing** gets a `202` join, not a `200` cache hit, so the client still receives `key_ready`.
   - In-flight jobs older than 30 minutes count as dead and are recreated. The hourly cleanup also closes them with an `error` event.
2. **SSE fallback from SQLite (§7):**
   - A ready track whose job is still running replays `progress:analyzing` + `audio_ready`, without `done`.
   - A ready track whose key detection failed replays that `KEY_DETECTION_FAILED` error, then `done`.
3. **Titles (§12):** path components are stripped from **upload filenames only**. Doing it to YouTube titles would turn "AC/DC - …" into "DC - …". Control characters, whitespace collapsing, the 120-character cap and "Untitled" apply to both.
4. **Upload limit unit:** `MAX_UPLOAD_MB` means **MiB** (50 × 1024 × 1024 bytes) on both the server and the browser.
5. **YouTube URL edge cases:**
   - Both parsers take the strict reading. Rejected: ports, userinfo, trailing-dot hosts, a scheme-relative `//`, `/watch/` and `youtu.be/<id>/` trailing slashes, and uppercase paths. Hosts are case-insensitive. The first `v` wins, percent-decoded, and fragments are ignored. Whitespace is trimmed with JavaScript's `trim()` set.
   - A **shared 45-case table** (`apps/api/tests/fixtures/youtube_urls.json` and its byte-identical copy `apps/web/src/lib/fixtures/youtube_urls.json`) is run against both parsers. `validate-manifests.sh` fails if the copies differ.

### Backend
6. **yt-dlp:**
   - Runs as a library, with Deno from the `yt-dlp[deno]` PyPI extra (`js_runtimes`) and the bundled `yt-dlp-ejs`.
   - No remote components and no cookies. Output goes to a fixed filename, never the title. Caches are under `TMP_DIR`.
   - It probes once and downloads from that probe result.
7. **Key detection:**
   - librosa 1.0 CQT chroma with Krumhansl-Kessler correlation and a softmax at temperature **0.07**, calibrated on synthetic songs.
   - **Harmonic separation is off**: a 4-minute song takes 0.5 s at `--cpus=1` without it, against 8 s with it.
   - The worker calls `warm_up()` at startup, which absorbs 2–4 s of numba compile time.
   - Any failure becomes `KeyDetectionError`, which is non-fatal.
8. **The image sets `NUMBA_CACHE_DIR=/tmp/numba-cache`.** Otherwise numba crashes when imported as a non-root user with no home directory, which is how production runs. This was verified with the production image at `--user 10001 --read-only --cap-drop ALL`.
9. **SQLite:** first-open races between api and worker retry until the 5 s busy timeout.
10. **Logging:** uvicorn's access log drops client IPs and query strings, and health-probe lines are dropped altogether.
11. **Tests:**
    - `fakeredis[lua]` (with `lupa`, MIT, arm64 wheels) runs the rate-limit Lua script in unit tests.
    - The script's Valkey-specific tests use a real Valkey through `KEYSHIFT_TEST_REDIS_URL`: a service container in CI, and a throwaway container locally.

### Browser
12. **Signalsmith Stretch 1.3.2** inlines its WASM and builds its AudioWorklet from a **Blob URL** at runtime:
    - nothing extra to serve, and no `.wasm` MIME type needed
    - `public/worklets/` from §6.1 is unused
    - **if a CSP is ever added, it must allow `blob:` in `script-src` and `'wasm-unsafe-eval'`**
    - the library never revokes that ~100 KB Blob URL per context (minor)
13. **Engine memory is about 2× the decoded track** (one copy for the waveform, one in the worklet, ~170 MB for 4 minutes at 48 kHz), plus a temporary copy while exporting. D1 assumed about 85 MB. §11 already plans streaming for long tracks on low-memory devices.
14. **Engine behavior:**
    - Pitch ramps are 4 timer-driven steps over 40 ms, because the library's schedule keeps only one future entry.
    - `renderOffline` always returns stereo.
    - Semitones are rounded and clamped to ±12, cents clamped to ±50, and non-finite values throw.
15. **Error mapping when the body isn't JSON** (e.g. the Ingress's HTML 413 page): 413 → `FILE_TOO_LARGE`, 429 → `RATE_LIMITED`, anything else → `INTERNAL`.
16. **Bundle size:**
    - Input screen: 78 KB gzipped (mostly React).
    - Loaded on demand: the player (6 KB), engine (4 KB), wavesurfer v8 (14 KB) and Signalsmith (44 KB).
    - Lighthouse on the production image scores **Accessibility 100 and Best Practices 100**, with mobile FCP/LCP 1.4 s, 0 ms blocking time and 0 layout shift. The overall Performance score couldn't be computed in the container, because headless Chromium doesn't capture the screenshots Speed Index needs. Confirm it in Chrome DevTools.

### Tooling and CI
17. **CI runs:**
    - api: ruff, mypy, and pytest with coverage. `routes/`, `audio/` and `worker/` must each be ≥ 80% (they're at 100%). The Valkey service is attached.
    - web: lint, format, types, and Vitest with coverage thresholds of 90/85/90/90 (currently about 99/96/99/100).
    - `engine-browser`: Playwright 1.63 image, Chromium/Firefox/WebKit.
    - `e2e`: the Compose stack plus the happy path.
    - manifests.
18. **Dependabot** opens a weekly uv PR for yt-dlp (plus monthly npm and Actions PRs). This is the §14 "keep yt-dlp current" mitigation, deferred in ADR 0002. Merging produces a new SHA and new images, so tags stay immutable.
19. **`make dev` needs host ffmpeg/ffprobe** from Phase 1 on. It fails fast with a hint, and nothing is installed automatically (amends ADR 0004). `make up` needs nothing extra.
20. **New make targets:** `test-browser` (engine specs) and `e2e` (the happy path against `make up-d`), both in the pinned Playwright image.

## Consequences
- **Firefox's real-time engine specs** (play/advance/ended) skip in containers with no audio device. Offline pitch, tempo and export specs pass in all three browsers.
- **Manual checks still owed** before calling Phase 1 done on real devices:
  - audible dial change in < 100 ms with no clicks (Chrome, Firefox, Safari, one phone)
  - Safari/iOS AudioContext resume and download filename
  - Lighthouse Performance in DevTools
  - touch dragging on the dial
- **YouTube ingest is covered by mocked-yt-dlp tests only.** No real YouTube request was made during development (ToS, and the dev machine is on a corporate network). The first real fetch happens on the VM.

## Addendum (2026-09-27): audio-engine failures
VS Code's built-in browser showed one generic "couldn't play" message for every song: it's Chromium without proprietary codecs, so `decodeAudioData` rejects our AAC (D8), and the hook swallowed the cause. Engine failures are now an additive `EngineError` (exported from `src/audio`; the §6.8 `AudioEngine` interface is unchanged) with a `kind`: `unsupported` (no Web Audio, AudioWorklet or WebAssembly, or the Signalsmith node's ready handshake doesn't arrive within 15 s, which is what happens when WebAssembly is blocked inside the worklet and used to hang forever), `network` (the audio or an engine chunk didn't download), `decode`, `processor` (`processorerror`) and `playback` (`resume()` refused). Aborts from a newer `load()` or `dispose()` stay plain `AbortError`s. WebAssembly is checked up front (`typeof` plus compiling an 8-byte module, which also catches a CSP without `'wasm-unsafe-eval'`); the worklet inherits the page's engine flags and policy, and the timeout covers anything else. AAC is **not** checked up front: `canPlayType` and `MediaSource.isTypeSupported` describe the media pipeline, not Web Audio's decoder, and a false "no" would block a browser that works. They're asked only after a decode failure, to add the `no-aac` hint and say "can't decode AAC". The player keeps the error, logs it once with its kind and cause, shows cause-specific copy with a collapsed "Technical details", strengthens the hint when the user agent looks like Electron or VS Code (never a block), and offers "Try again" (a fresh engine, same URL) for `network`, `processor` and `playback`. A `playback` error doesn't disable the player: the next Play press resumes again.
