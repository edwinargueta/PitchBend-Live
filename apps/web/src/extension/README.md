<!-- Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009 -->

# PitchBend Live for Chrome

A Chrome extension that transposes the YouTube video you're watching, live, without changing its tempo. It taps the audio the page is already playing, shifts it in your browser, and plays the result. **Nothing is downloaded, saved, recorded or sent anywhere**: there are no network calls, no download permission and no persistent storage. That's how it gets around YouTube blocking the server (`SOURCE_BLOCKED`), because there's nothing to fetch. See [ADR 0009](../../../../docs/adr/0009-chrome-extension-live-transpose.md) for the decision and the [system design](../../../../docs/chrome-extension-design.md) for how it works, with diagrams.

- **Sites:** `www.youtube.com` and `music.youtube.com`.
- **Transpose:** −12…+12 semitones, with pitch only. A 4:00 song still ends at 4:00.
- **Per tab:** each tab keeps its own transpose until you close it, and a reload keeps it. The next video in the same tab keeps the transpose but clears the original key you picked. Ads are transposed too.
- **Original key:** pick it yourself (tonic + major/minor) to see "G major → A major (+2)" and a capo hint. Automatic key detection is a later version.
- **Bypass** (or 0) plays the untouched original, with no added delay.
- **Delay:** while transposing, the audio runs about 70 ms behind the picture: 60 ms for the shifter, plus the audio output's own latency. The panel shows the exact figure.

## Build and load

```sh
make extension                         # builds apps/web/dist-extension (in the web container)
# or, with the host toolchain from `make setup`:
cd apps/web && pnpm build:extension
```

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick `apps/web/dist-extension`.
3. Pin **PitchBend Live** from the puzzle-piece menu if you like.
4. **Reload any YouTube tabs that were already open.** Content scripts only reach pages loaded after install.

After a rebuild, click the reload icon on the extension's card in `chrome://extensions`, then reload your YouTube tabs.

`dist-extension/` is git-ignored. The e2e suite builds a separate _probe_ variant under `node_modules/.cache/`. Never load that one, because it publishes test data on the page.

## Use

1. Open a YouTube video and click the PitchBend Live toolbar icon. The side panel opens for that tab.
2. If the video hasn't been clicked yet, the panel says **"Click the video once to enable PitchBend Live."** Chrome only lets audio processing start after you interact with the page. Until then you hear the original.
3. Turn the dial, or focus it and use ←/→ (±1) and `0` (reset).

| Shortcut (works on the active YouTube tab, panel open or not) | Default (macOS: ⌥ = Alt) |
| ------------------------------------------------------------- | ------------------------ |
| Up one semitone                                               | `Alt+Shift+↑`            |
| Down one semitone                                             | `Alt+Shift+↓`            |
| Back to the original key                                      | `Alt+Shift+0`            |
| Bypass on/off                                                 | `Alt+Shift+B`            |

Change them at `chrome://extensions/shortcuts`. Chrome leaves a shortcut unassigned if another extension already uses it.

## Troubleshooting

| You see                                                              | What to do                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Reload this YouTube tab to start PitchBend Live."                   | The tab was open before the extension was installed or updated. Reload it.                                                                                                                                                                                                                |
| "Open a YouTube or YouTube Music video in this tab to transpose it." | The panel follows the active tab, and this one isn't YouTube.                                                                                                                                                                                                                             |
| "Click the video once to enable PitchBend Live."                     | Click anywhere on the page (or press a key there).                                                                                                                                                                                                                                        |
| An error and the original audio keeps playing                        | The pitch shifter couldn't start, for example because YouTube changed its page security rules. The extension never mutes the video. Change the transpose to retry. If it still fails, open the console and filter by `[PitchBend Live]`.                                                  |
| **Load unpacked** is missing or greyed out                           | Your Chrome is managed (see `chrome://management`). Check `chrome://policy` for `ExtensionDeveloperModeSettings`, `DeveloperToolsAvailability` or `ExtensionInstallBlocklist`. A blocking policy means the extension can't run on that machine. Use a personal Chrome profile or machine. |

**Logs** stay local: the YouTube tab's DevTools console (filter `[PitchBend Live]`) and, for shortcuts and per-tab state, `chrome://extensions` → PitchBend Live → _Inspect views: service worker_. There's no telemetry.

## Tests

- **Unit** (Vitest, inside `make test-web` / `make check`): everything in this folder, except the three `main` wiring files, is at 100% coverage. `manifest.test.ts` pins the permissions and scans the source for network, download and storage calls.
- **End to end:** `make test-extension` loads the probe build into Playwright's Chromium. It serves a watch page _as_ `www.youtube.com` / `music.youtube.com` with YouTube's real CSP, entirely offline. It measures output frequencies (+2 on 440 Hz → 493.9 Hz), latency, bypass, next video, ads, reload, two tabs, shortcuts and YouTube Music. CI runs it as the `extension-browser` job.

What the automated suite can't prove is in the checklist below.

## Manual checklist (real YouTube, owner's Mac)

Run it on the current stable Chrome on macOS with a fresh `make extension` build. Use headphones for the latency items. Record the date, Chrome version (`chrome://version`) and laptop.

Date: ________ Chrome: ________ Laptop: ________

| #   | Check                                                                                                                                                                                     | Covers        | Pass | Fail |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---- | ---- |
| 1   | **Corporate policy:** `chrome://extensions` shows Developer mode and _Load unpacked_, and the extension loads with no errors on its card. If this fails, stop and use a personal machine. | Open question | ☐    | ☐    |
| 2   | **Basic transpose:** on a music video, after one click on the page, +2 sounds two semitones higher and the song keeps its tempo. The panel shows "Transposing this tab."                  | AC-1, AC-15   | ☐    | ☐    |
| 3   | **Dial feel:** sweeping −3 → +3 with ←/→ feels immediate (no perceptible lag, under about 100 ms) and has no clicks.                                                                      | AC-2          | ☐    | ☐    |
| 4   | **A/V offset:** at +2, lips and drum hits don't feel late. The panel's "Audio delay behind the video" reads ≤ 80 ms.                                                                      | AC-3          | ☐    | ☐    |
| 5   | **10-minute soak** at +5 (a long video or a playlist, with other tabs open as usual): zero audible gaps or dropouts.                                                                      | AC-4          | ☐    | ☐    |
| 6   | **Before any click:** in a fresh tab, open a video and set +2 before clicking the page. The panel asks for a click and the original plays. After a click it transposes.                   | AC-6          | ☐    | ☐    |
| 7   | **Bypass:** the panel button and `Alt+Shift+B` switch between original and transposed smoothly. The original has no delay.                                                                | AC-7          | ☐    | ☐    |
| 8   | **Next video:** at +2 with a key picked, click a recommended video. It plays at +2 and the key is cleared.                                                                                | AC-8          | ☐    | ☐    |
| 9   | **Ads:** on a video with a pre-roll or mid-roll ad, the ad plays transposed and the video resumes transposed after it.                                                                    | AC-12         | ☐    | ☐    |
| 10  | **Seek, pause, background:** seeking, pausing and resuming, and switching to another tab and back all keep the transpose, with no silence.                                                | AC-4          | ☐    | ☐    |
| 11  | **Per tab:** two YouTube tabs at different transposes stay independent. Reloading one keeps its transpose, and closing it forgets it.                                                     | AC-9          | ☐    | ☐    |
| 12  | **Shortcuts** work on the active YouTube tab with the panel closed.                                                                                                                       | AC-11         | ☐    | ☐    |
| 13  | **YouTube Music:** the same transpose works on `music.youtube.com`.                                                                                                                       | FR-1          | ☐    | ☐    |
| 14  | **Nothing downloaded:** DevTools → Network on the YouTube tab, with the extension in use, shows no requests from the extension other than its own `chrome-extension://` files.            | AC-13         | ☐    | ☐    |

If any item fails, note the video, what you heard and any `[PitchBend Live]` console lines.

## Layout

| Path                             | What                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest.json`                  | MV3 manifest: `sidePanel` + `storage`, the two YouTube origins, four commands                                                        |
| `content/`                       | Content script: video tracking, the audio graph (`liveGraph.ts`), the controller state machine, the worklet loader and the e2e probe |
| `background/`                    | Service worker: shortcuts and per-tab session state                                                                                  |
| `panel/`                         | Side panel (React): dial, bypass, key picker, readout                                                                                |
| `shared/`                        | Message protocol, settings logic, Chrome API seams, logger                                                                           |
| `testing/`                       | Fakes for Web Audio and the Chrome APIs (unit tests only)                                                                            |
| `../../vite.extension.config.ts` | Two-part build: panel and worker as modules, content script as one IIFE                                                              |
| `../../e2e/extension/`           | Playwright suite and the YouTube fixture                                                                                             |
