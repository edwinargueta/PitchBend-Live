# PitchBend Live Chrome extension: system design

How the extension transposes a YouTube video live, in the user's own tab, without downloading anything.

| | |
|---|---|
| **Version** | 0.1.0 (branch `extension/live-transpose`, 2026-11-13) |
| **Decision record** | [ADR 0009](adr/0009-chrome-extension-live-transpose.md). It supersedes ADR 0008 and the desktop-shell spike |
| **Code** | [`apps/web/src/extension/`](../apps/web/src/extension/) |
| **Owner guide and manual checklist** | [`apps/web/src/extension/README.md`](../apps/web/src/extension/README.md) |

If this overview and the code or ADR 0009 disagree, the code and ADR win. Fix the overview.

---

## 1. The problem and the idea

- **The server can't fetch YouTube.** YouTube bot-checks the Oracle datacenter IP, so every YouTube link in the web app fails with `SOURCE_BLOCKED`.
- **Downloading isn't an option anyway.** The Chrome Web Store forbids extensions that "facilitate … the unauthorized access, download, or streaming of copyrighted content", and so do YouTube's ToS and CLAUDE.md §7.
- **The audio is already playing in the user's browser.** The extension takes the sound of YouTube's own `<video>` element, shifts its pitch with Web Audio, and plays the result. Nothing is fetched, stored, recorded or sent. The PitchBend Live server isn't involved at all.

| Goal | Target | How it's met |
|---|---|---|
| Pitch only, tempo untouched | A 4:00 song still ends at 4:00 | The video keeps its own clock at rate 1.0. The shifter changes pitch only (§3) |
| Small delay behind the picture | ≤ 80 ms | 60 ms shifter blocks + the output's base latency. Measured 70 ms (§7) |
| The dial feels immediate | ≤ 20 ms from panel to shifter | Direct extension messaging, no server. Measured 0.9 ms |
| Never silent | The video is never muted by a failure | The dry path is connected first, and the graph is never torn down (§3, §8) |
| Per tab, private | Settings forgotten when the tab closes | `chrome.storage.session`, which lives in memory only (§6) |
| Nothing leaves the browser | Zero network requests | No network APIs in the source. The e2e suite fails on any request (§9) |

## 2. Where it runs

```mermaid
flowchart LR
    user(["Musician"])

    subgraph chrome["User's Chrome"]
        subgraph tab["YouTube tab"]
            player["YouTube's player<br/>main video element"]
            cs["Content script<br/>isolated world"]
            audio["Web Audio graph<br/>Signalsmith Stretch in an AudioWorklet"]
        end
        subgraph ext["Extension pages"]
            panel["Side panel<br/>dial, bypass, key picker"]
            sw["Service worker<br/>shortcuts, per-tab state"]
            session[("chrome.storage.session<br/>memory only")]
        end
        out(["Speakers / headphones"])
    end

    yt[("YouTube servers")]
    server[("PitchBend Live server<br/>Oracle VM")]

    user --> panel
    user -- "Alt+Shift+Up, Down, 0, B" --> sw
    yt -- "normal playback, by YouTube's own player" --> player
    player -- "audio" --> audio
    cs -- "builds and controls" --> audio
    audio --> out
    panel <-->|"commands and status"| cs
    sw -- "shortcut commands" --> cs
    cs -- "status" --> sw
    sw --> session
    cs -. "never contacted" .-> server

    classDef unused stroke-dasharray: 5 5
    class server unused
```

The extension has four parts, all in [`apps/web/src/extension/`](../apps/web/src/extension/):

| Part | Runs in | Job |
|---|---|---|
| **Content script** (`content/`) | Every YouTube tab, in Chrome's isolated world. Built as one classic script, `content.js` | Finds the main video, builds and owns the audio graph, applies commands, reports status |
| **Pitch shifter** (`vendor/signalsmith-stretch.mjs`) | The tab's AudioWorklet thread | Signalsmith Stretch (MIT, WebAssembly) in live-input mode, shipped unchanged as a web-accessible resource |
| **Service worker** (`background/`) | The extension's background, woken by events | Routes keyboard shortcuts, saves each tab's settings in session storage, forgets closed tabs, opens the side panel from the toolbar icon |
| **Side panel** (`panel/`) | An extension page beside the tab (React) | The dial (the web app's `KeyDial`), bypass, the original-key picker, "G major → A major (+2)", capo, status and delay readout |

Shared code (`shared/`) holds the message protocol, the settings reducer and thin seams over the Chrome APIs. The extension reuses the web app's `src/audio/pitch.ts`, `src/audio/ramp.ts`, `src/lib/music.ts` and `KeyDial` read-only.

## 3. The audio graph

The content script builds one graph per tab, the first time a transpose is asked for:

```mermaid
flowchart LR
    video["YouTube's video element<br/>plays at rate 1.0"]
    src["MediaElementSource"]
    dry["Dry gain<br/>original sound"]
    subgraph worklet["AudioWorklet thread"]
        stretch["Signalsmith Stretch<br/>live input, 60 ms blocks<br/>pitch ±12 semitones"]
    end
    wet["Wet gain<br/>transposed sound"]
    dest(["AudioContext destination<br/>speakers"])

    video --> src
    src --> dry --> dest
    src --> stretch --> wet --> dest
```

- **Capturing:** `createMediaElementSource(video)` reroutes the element's sound into this graph, so from then on it only comes out through the graph. That's why the rules below exist.
- **Dry first:** the dry path is connected at full gain *before* the shifter is loaded. The moment the video is captured, you hear the original, unchanged.
- **Crossfade:** when the shifter is running and the transpose isn't 0, the dry gain fades to 0 and the wet gain to 1 over 30 ms. Bypass, a transpose of 0, or any error fade back to dry. At 0 you hear the true original, with no added delay.
- **Never torn down:** a captured source is never disconnected and the AudioContext is never closed, because either would mute the video. The graph lives as long as the page.
- **Pitch changes glide:** each new semitone value is applied in 4 steps over 40 ms (`PitchRamp`, with `node.schedule({ semitones })`), so dial moves don't click.
- **Tempo is untouched:** the video element still drives playback at its own rate. In live-input mode the stretcher only shifts pitch, so the song keeps its length. The sound simply trails the picture by the shifter's latency.
- **Same element, new source:** ads, the next video and quality changes usually keep the same `<video>` element and swap its source. The graph keeps running through them, so ads are transposed too.

## 4. Loading the shifter under YouTube's CSP

The library normally loads its worklet code from a Blob URL, and YouTube's Content Security Policy refuses those. The extension ships the library's `.mjs` file as-is and points both the import and the worklet at it. The same file registers the processor when it loads inside a worklet. Spike E1 proved this against YouTube's real CSP (+12 on 440 Hz measured 882 Hz).

```mermaid
sequenceDiagram
    participant CS as Content script
    participant Files as Extension files
    participant Ctx as AudioContext in the YouTube page
    participant W as AudioWorklet scope

    CS->>Files: import(getURL("vendor/signalsmith-stretch.mjs"))
    Files-->>CS: module, default export = factory
    CS->>CS: factory.moduleUrl = the same URL
    CS->>Ctx: factory(ctx, options)
    Ctx->>W: audioWorklet.addModule(moduleUrl)
    Note over Ctx,W: Allowed: a web-accessible extension file.<br/>A Blob URL is refused by YouTube's CSP.
    W->>W: the same file registers the processor and compiles WASM
    W-->>CS: StretchNode
    CS->>W: configure blockMs 60, intervalMs 15
    CS->>W: latency() returns 60 ms
    Note over CS: 5 s timeout. On any failure the sound stays dry,<br/>the panel shows why, and the next change retries.
```

- Only that one file is web-accessible, and only to the two YouTube origins.
- WebAssembly compiles because YouTube's CSP allows `'unsafe-eval'`.
- If YouTube ever tightens its CSP, ADR 0009 records the fallback: `tabCapture` plus an offscreen document.

## 5. The tab's state machine

`ContentController` (`content/controller.ts`) decides when audio may be touched. It never creates an AudioContext before the page has had a user gesture, because Chrome would start it suspended. Capturing the video into a suspended context would mute it.

```mermaid
stateDiagram-v2
    state "idle" as idle
    state "no-video" as no_video
    state "waiting-gesture" as waiting
    state "starting" as starting
    state "active" as active
    state "error" as error

    [*] --> idle
    idle --> no_video: transpose set, no video on the page
    no_video --> idle: a video appears
    idle --> waiting: transpose set, page not clicked yet
    idle --> starting: transpose set, page already clicked
    waiting --> starting: click or key press on the page
    starting --> waiting: AudioContext still suspended
    starting --> active: shifter running
    starting --> error: shifter failed or timed out
    error --> starting: next transpose change retries
```

| State | What you hear | Panel says |
|---|---|---|
| idle | The original (the graph doesn't exist yet) | "Ready. Move the dial to transpose this video." |
| no-video | The original | "No video found on this page." |
| waiting-gesture | The original, untouched | "Click the video once to enable PitchBend Live." |
| starting | The original (dry path) | "Starting the pitch shifter…" |
| active | Transposed, or the original when bypassed or at 0 | "Transposing this tab." plus the delay |
| error | The original (dry path) | The reason, e.g. "The pitch shifter couldn't start. The video plays without transposing." |

## 6. Messages and state

All messaging stays inside Chrome's extension APIs. Messages are typed in `shared/protocol.ts`, checked by runtime guards, and accepted only from this extension's own ID.

| Message | From → to | Carries |
|---|---|---|
| `Command`: `set`, `nudge`, `reset`, `setBypass`, `toggleBypass`, `setKey`, `getStatus` | Panel or service worker → content script (`chrome.tabs.sendMessage`) | The change, plus `sentAt` for latency measurement |
| `TabStatus` (the reply) | Content script → whoever sent the command | State, settings, site, shifter and added latency, error text, timestamps |
| `status` push | Content script → all extension pages (`chrome.runtime.sendMessage`) | The same `TabStatus`, on every change |
| `restoreRequest` | Content script → service worker | Asks for this tab's saved settings after a reload |

Every semitone value passes through one normalizer (`tabState.ts`: clamp to −12…+12 and round), whether it comes from the panel, a shortcut or a restore.

### A dial move

```mermaid
sequenceDiagram
    actor U as User
    participant P as Side panel
    participant C as Content script
    participant G as Audio graph
    participant S as Service worker

    U->>P: ArrowRight on the dial
    P->>P: show +2 at once (optimistic)
    P->>C: set semitones 2, sentAt
    C->>C: normalize to -12..+12, update settings
    C->>G: setShift(2), 4 steps over 40 ms
    C->>G: crossfade dry to wet, 30 ms
    C-->>P: reply TabStatus, authoritative
    C--)S: status push
    S->>S: save settings under tab:ID
    C--)P: status push
    Note over P: While a reply is pending, a push updates the state<br/>but keeps the optimistic settings, so quick presses add up.
```

### Keyboard shortcuts

```mermaid
sequenceDiagram
    actor U as User
    participant Chrome as chrome.commands
    participant S as Service worker
    participant C as Content script

    U->>Chrome: Alt+Shift+Up on a YouTube tab
    Chrome->>S: onCommand("transpose-up", tab)
    S->>S: look up SHORTCUTS, check the tab is YouTube
    S->>C: nudge +1, sentAt
    C-->>S: TabStatus
    Note over S,C: Works with the panel closed. A tab opened before install<br/>has no content script, so it gets a log line, not an error.
```

### Reload and close

```mermaid
sequenceDiagram
    participant C as New content script
    participant S as Service worker
    participant St as storage.session

    Note over C: The page reloads. Publishing is held until restore,<br/>so the fresh defaults can't overwrite the saved settings.
    C->>S: restoreRequest
    S->>St: get tab:ID
    St-->>S: semitones 3, bypass off
    S-->>C: saved settings
    C->>C: restore, then wait for a click if needed
    C--)S: status push with +3, saved again
    Note over S,St: When the tab closes, tabs.onRemoved deletes tab:ID.
```

A command that arrives before the restore reply wins over the saved settings, because it's newer.

## 7. Following YouTube's single-page navigation

YouTube rarely reloads the document. The next video usually reuses the same `<video>` element with a new source. `VideoTracker` (`content/videoTracker.ts`) watches for both kinds of change:

```mermaid
flowchart TB
    nav["yt-navigate-finish<br/>YouTube's own event"] --> refresh
    load["media loadstart<br/>capture phase"] --> refresh
    dom["DOM changes<br/>debounced 250 ms"] --> refresh

    refresh{"Re-check the main video<br/>and the URL's video ID"}
    refresh -- "different element" --> el["setVideo: capture it,<br/>dry first, same graph"]
    refresh -- "different video ID" --> vid["videoChanged: keep the transpose,<br/>clear the original key"]
    refresh -- "same element, same ID<br/>ad, seek, quality change" --> keep["nothing to do:<br/>the graph keeps running"]
```

- **Finding the main video:** `#movie_player video.html5-main-video`, then `video.html5-main-video`, then the largest `<video>` on the page.
- **The video ID** comes from `?v=` or `/shorts/<id>`. It's held in memory only and never stored.
- **The key is cleared on a new video** so the readout never names the wrong key. The transpose stays, because a musician usually practices a set in one key.

## 8. Latency budget

| Stage | Time | Notes |
|---|---|---|
| Panel input → shifter | **0.9 ms** measured | AC-2 limit 20 ms. The panel and the content script share timestamps (`performance.timeOrigin + now()`) |
| Pitch glide | 40 ms | 4 steps, to avoid clicks. It doesn't delay the audio |
| Shifter latency | **60 ms** | `blockMs: 60`. The library's default preset is 120 ms |
| Output base latency | ≈ 10 ms | `AudioContext({ latencyHint: "interactive" })`. Depends on the device |
| **Sound behind picture** | **70 ms** measured | AC-3 limit 80 ms. The panel shows the live figure. At 0 or bypass it's only the base latency |
| Change audible at the output (test) | ≤ 176 ms measured | AC-2 limit 500 ms. Includes the test analyser's 8192-point window |

The figures were measured by the Playwright e2e suite in Chromium. The perceptual checks (dial feel under 100 ms, lips and drums not feeling late) are in the manual checklist.

## 9. Privacy, permissions and safety

| Manifest entry | Value | Why |
|---|---|---|
| `permissions` | `sidePanel`, `storage` | The panel, and `chrome.storage.session` for per-tab settings |
| `host_permissions` | `https://www.youtube.com/*`, `https://music.youtube.com/*` | Inject the content script there and nowhere else |
| `web_accessible_resources` | `vendor/signalsmith-stretch.mjs`, YouTube origins only | The worklet loading in §4 |
| `commands` | four shortcuts | `Alt+Shift+Up/Down/0/B` |
| Not requested | `downloads`, `tabCapture`, `tabs`, `cookies`, remote code, a custom CSP | Nothing is downloaded, recorded or sent |

- **Stored:** only `{ semitones, bypass, key }` per tab, in memory-only session storage. It's deleted when the tab closes and wiped when Chrome quits. There's no telemetry, and logs go only to the local DevTools consoles, prefixed `[PitchBend Live]`.
- **Guarded by tests:**
  - `manifest.test.ts` pins every manifest entry above.
  - The same test scans the extension's source and fails on `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `chrome.downloads`, `storage.local`/`sync`, `document.cookie`, `innerHTML`, `eval` and `MediaRecorder`.
  - The e2e suite records any http(s) request that isn't the fixture and fails if there is one.
- **Trust boundary:** the content script accepts commands only from its own extension ID, and every message is shape-checked. The page can't send it commands.

## 10. Failure modes

| Failure | You hear | Panel shows | Recovery |
|---|---|---|---|
| The page hasn't been clicked yet | The original | "Click the video once to enable PitchBend Live." | One click on the page |
| The shifter can't load (CSP or WebAssembly blocked, 5 s timeout) | The original | The error, and that the video plays without transposing | The next change retries. ADR 0009's fallback is `tabCapture` |
| Another extension already captured the video | The original | "Another extension or the page already controls this video's audio." | Disable the other extension |
| The tab was open before install or update | The original | "Reload this YouTube tab to start PitchBend Live." | Reload the tab |
| No video on the page | Nothing changes | "No video found on this page." | Automatic when a video appears |
| YouTube changes its player markup | The original, or the largest video | Depends on what's found | The fallback selector, then a code fix |
| The service worker was asleep | No effect | — | MV3 wakes it on the next event. Settings are in session storage, not worker memory |

Rollback is disabling or removing the extension in `chrome://extensions`, which leaves YouTube untouched. There's no server, migration or contract change.

## 11. Build and packaging

```mermaid
flowchart LR
    subgraph srcs["apps/web/src/extension"]
        man["manifest.json"]
        cmain["content/main.ts"]
        bmain["background/main.ts"]
        pmain["panel/index.html, main.tsx"]
    end
    lib["signalsmith-stretch<br/>SignalsmithStretch.mjs, MIT"]

    pages["vite build<br/>pages part: ES modules"]
    content["vite build<br/>EXTENSION_PART=content: one IIFE"]

    subgraph dist["apps/web/dist-extension: Load unpacked"]
        dman["manifest.json"]
        dsw["service-worker.js"]
        dpanel["panel/index.html, assets/"]
        dvendor["vendor/signalsmith-stretch.mjs"]
        dcontent["content.js"]
    end

    man --> pages
    bmain --> pages
    pmain --> pages
    lib --> pages
    pages --> dman
    pages --> dsw
    pages --> dpanel
    pages --> dvendor
    cmain --> content --> dcontent
```

- **Two builds** (`apps/web/vite.extension.config.ts`), because a content script must be a single classic script while the panel and worker are ES modules. `make extension` runs both in the web container.
- **The library file is copied byte for byte.** It isn't bundled, because it must be the same file the worklet loads.
- **The probe build** (`--mode probe`) adds test hooks and goes to `node_modules/.cache/extension-probe-dist`, so it can't be mistaken for the real build. The production build contains no probe code (checked).
- The extension lives inside `apps/web`, sharing its lockfile, Docker image and `make check`. A separate package was rejected in ADR 0009.

## 12. How it's tested

```mermaid
flowchart LR
    pw["Playwright 1.63<br/>persistent Chromium context"]
    build["Unpacked probe build<br/>of the extension"]
    routes["context.route: www and music.youtube.com<br/>serve the fixture with YouTube's CSP"]
    escape["any other http or https request<br/>recorded and aborted, must stay empty"]
    fixture["Fixture watch page<br/>in-page WAV tones 440, 550, 660 Hz"]
    probe["Probe: analyser on the graph output<br/>frequency and status on the page"]
    panelpage["Side panel page<br/>opened with ?tabId="]

    pw --> build
    pw --> routes --> fixture
    pw --> escape
    fixture --> probe
    pw -- "drives the dial" --> panelpage
    pw -- "reads frequency and latency" --> probe
```

| Layer | Runs | Covers |
|---|---|---|
| **Unit** (Vitest, fakes for Web Audio and Chrome) | `make test-web`, `make check`, CI `web` | Every module except the three `main` wiring files, at 100% line and branch coverage. State machine, graph rules, normalizer, protocol guards, panel copy, manifest and source scan |
| **End to end** (Playwright Chromium) | `make test-extension`, CI `extension-browser` | +2 → 493.9 Hz at rate 1.0, latency, waiting for a click, worklet failure stays at 440 Hz, bypass, next video and ads, reload and close, two tabs, shortcuts, YouTube Music, zero network |
| **Manual** (owner, real YouTube) | The checklist in the extension README | 10-minute soak, real ads, stable Chrome on macOS, perceived latency and A/V offset, corporate-policy check |

Two test-only notes:
- Playwright's Chromium evaluations count as user gestures, so the "before any click" test uses a probe-only `pblProbeNoActivation` flag. The click that then resumes the audio is real.
- Headless Chromium can't press browser-level shortcuts, so the probe service worker exposes `pblShortcut(name)`, which calls the same handler.

## 13. Not in v0.1 (yet)

- **Automatic key detection:** the user picks the original key. A progressive in-browser estimate is planned for v2.
- **Cents fine-tuning:** deferred.
- **Chrome Web Store publishing:** the build is store-compatible, but publishing has a one-time fee and is the owner's call.
- **Other sites and embedded players:** out of scope. Only the two YouTube origins.
- **Windows and older Chrome:** not tested. v0.1 targets the owner's current stable Chrome on macOS.
- **Downloading or exporting YouTube audio:** never. Exporting with the transpose applied stays in the web app, for uploaded files.
