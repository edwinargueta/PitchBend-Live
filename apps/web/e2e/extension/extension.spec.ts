// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// The Chrome extension end to end (AC-1, 2, 3, 6, 7, 8, 9, 11, 13, 15):
// Chromium with the unpacked probe build, a fixture served as YouTube with
// YouTube's CSP, the real content script, worklet, service worker and side
// panel. Run with `make test-extension` (or `pnpm test:e2e:extension`).
//
// Playwright runs its page evaluations as user gestures in Chromium, so a
// Playwright page always has user activation. The no-activation test (AC-6)
// sets the probe's `pblProbeNoActivation` flag instead; its click is real.
import path from "node:path";
import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import type { ProbeSample } from "../../src/extension/content/probe";
import {
  isFixtureUrl,
  isNetworkEscape,
  shifted,
  WATCH_PAGE,
  YOUTUBE_CSP,
} from "./fixture";

const EXTENSION_DIR = path.resolve(
  process.env.PW_EXTENSION_DIR ?? "node_modules/.cache/extension-probe-dist",
);
const WATCH_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

interface Fixtures {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  /** Requests that tried to leave the browser (must stay empty, AC-13). */
  escaped: string[];
}

const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their dependencies; this one has none.
  escaped: async ({}, provide) => {
    await provide([]);
  },
  context: async ({ escaped }, provide) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    await context.route(
      (url) => isFixtureUrl(url.href),
      (route) =>
        route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": YOUTUBE_CSP,
          },
          body: WATCH_PAGE,
        }),
    );
    await context.route(
      (url) => isNetworkEscape(url.href),
      (route) => {
        escaped.push(route.request().url());
        return route.abort();
      },
    );
    await provide(context);
    await context.close();
  },
  worker: async ({ context }, provide) => {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await provide(worker);
  },
  extensionId: async ({ worker }, provide) => {
    await provide(new URL(worker.url()).host);
  },
});

// ---- helpers ----------------------------------------------------------------

interface SwGlobals {
  chrome: {
    tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> };
    storage: { session: { get(key: null): Promise<Record<string, unknown>> } };
  };
  pblShortcut(name: string): Promise<void>;
}

async function openWatch(
  context: BrowserContext,
  url = WATCH_A,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await expect.poll(() => readProbe(page).then((p) => p?.state)).toBe("idle");
  return page;
}

async function readProbe(page: Page): Promise<ProbeSample | null> {
  const raw = await page.evaluate(
    () => document.documentElement.dataset.pblProbe,
  );
  return raw ? (JSON.parse(raw) as ProbeSample) : null;
}

async function probe(page: Page): Promise<ProbeSample> {
  const sample = await readProbe(page);
  if (!sample) throw new Error("no probe sample");
  return sample;
}

async function tabIdOf(worker: Worker, page: Page): Promise<number> {
  const url = page.url();
  const id = await worker.evaluate(async (wanted) => {
    const { chrome } = globalThis as unknown as SwGlobals;
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === wanted)?.id ?? null;
  }, url);
  if (id === null) throw new Error(`no tab for ${url}`);
  return id;
}

async function openPanel(
  context: BrowserContext,
  extensionId: string,
  tabId: number,
): Promise<Page> {
  const panel = await context.newPage();
  await panel.goto(
    `chrome-extension://${extensionId}/panel/index.html?tabId=${String(tabId)}`,
  );
  return panel;
}

/** Wait until the output's dominant frequency is within ±0.5 % of `hz`. */
async function expectFrequency(page: Page, hz: number): Promise<number> {
  const seen: { freq: number | null } = { freq: null };
  await expect
    .poll(
      async () => {
        seen.freq = (await probe(page)).freq;
        return seen.freq !== null && Math.abs(seen.freq - hz) / hz <= 0.005;
      },
      {
        message: `output ≈ ${hz.toFixed(1)} Hz`,
        timeout: 15_000,
        intervals: [50],
      },
    )
    .toBe(true);
  return seen.freq ?? Number.NaN;
}

async function transposeTo(
  panel: Page,
  page: Page,
  semitones: number,
): Promise<void> {
  const slider = panel.getByRole("slider");
  await expect(slider).toBeVisible();
  const now = Number(await slider.getAttribute("aria-valuenow"));
  const key = semitones > now ? "ArrowRight" : "ArrowLeft";
  for (let i = 0; i < Math.abs(semitones - now); i++) await slider.press(key);
  await expect
    .poll(() => probe(page).then((p) => p.settings.semitones))
    .toBe(semitones);
}

async function playingAt(
  context: BrowserContext,
  worker: Worker,
  extensionId: string,
  semitones: number,
  url = WATCH_A,
) {
  const page = await openWatch(context, url);
  await page.click("#play");
  const panel = await openPanel(
    context,
    extensionId,
    await tabIdOf(worker, page),
  );
  await transposeTo(panel, page, semitones);
  await expect.poll(() => probe(page).then((p) => p.state)).toBe("active");
  return { page, panel };
}

// ---- tests ------------------------------------------------------------------

test.afterEach(({ escaped }) => {
  // AC-13: nothing the pages or the extension did tried to leave the browser.
  expect(escaped).toEqual([]);
});

test.describe("PitchBend Live extension", () => {
  test("transposes the playing video live under YouTube's CSP (AC-1, AC-3)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const { page, panel } = await playingAt(context, worker, extensionId, 2);
    const freq = await expectFrequency(page, shifted(440, 2));
    const sample = await probe(page);
    const playbackRate = await page.evaluate(
      () => document.querySelector("video")?.playbackRate,
    );
    test.info().annotations.push({
      type: "measured",
      description: `+2 → ${freq.toFixed(2)} Hz; shifter ${String(sample.shifterMs)} ms; added ${String(sample.addedMs)} ms`,
    });
    expect(playbackRate).toBe(1);
    expect(sample.shifterMs).not.toBeNull();
    expect(sample.shifterMs ?? Infinity).toBeLessThanOrEqual(60);
    expect(sample.addedMs ?? Infinity).toBeLessThanOrEqual(80);
    await expect(panel.getByText("Transposing this tab.")).toBeVisible();
    await expect(
      panel.getByText(/Audio delay behind the video: \d+ ms/),
    ).toBeVisible();
  });

  test("applies a dial change within 20 ms and it's heard quickly (AC-2)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const { page, panel } = await playingAt(context, worker, extensionId, 2);
    await expectFrequency(page, shifted(440, 2));
    // Watch for the first probe sample at the new pitch from inside the page
    // (5 ms polling; the probe itself publishes every 50 ms).
    const heard = page.evaluate(
      async (target) => {
        const started = performance.now();
        for (;;) {
          const raw = document.documentElement.dataset.pblProbe;
          const sample = raw ? (JSON.parse(raw) as ProbeSample) : null;
          if (
            sample?.freq != null &&
            sample.sentAt !== null &&
            Math.abs(sample.freq - target) / target <= 0.005
          ) {
            return sample;
          }
          if (performance.now() - started > 5000) return null;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
      shifted(440, 3),
    );
    await panel.getByRole("slider").press("ArrowRight");
    const sample = await heard;
    expect(sample, "the new pitch was never heard").not.toBeNull();
    if (!sample) return;
    const control = (sample.appliedAt ?? Infinity) - (sample.sentAt ?? 0);
    const heardMs = sample.at - (sample.sentAt ?? 0);
    test.info().annotations.push({
      type: "measured",
      description: `panel → shifter ${control.toFixed(1)} ms; heard within ${heardMs.toFixed(0)} ms (incl. the 8192-point analyser window and 50 ms probe interval)`,
    });
    expect(control).toBeLessThanOrEqual(20);
    expect(heardMs).toBeLessThan(500);
  });

  test("waits for a click on the page before touching the audio (AC-6)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const page = await openWatch(context);
    await page.evaluate(() => {
      document.documentElement.dataset.pblProbeNoActivation = "1";
    });
    const panel = await openPanel(
      context,
      extensionId,
      await tabIdOf(worker, page),
    );
    await transposeTo(panel, page, 2);
    expect((await probe(page)).state).toBe("waiting-gesture");
    expect(
      await page.evaluate(() => document.querySelector("video")?.paused),
    ).toBe(true);
    await expect(
      panel.getByText("Click the video once to enable PitchBend Live."),
    ).toBeVisible();
    await page.click("#play");
    await expect.poll(() => probe(page).then((p) => p.state)).toBe("active");
    await expectFrequency(page, shifted(440, 2));
  });

  test("keeps the original audio when the shifter can't start (AC-6)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const page = await openWatch(context);
    await page.evaluate(() => {
      document.documentElement.dataset.pblProbeFailWorklet = "1";
    });
    await page.click("#play");
    const panel = await openPanel(
      context,
      extensionId,
      await tabIdOf(worker, page),
    );
    await transposeTo(panel, page, 2);
    await expect.poll(() => probe(page).then((p) => p.state)).toBe("error");
    await expectFrequency(page, 440);
    await expect(panel.getByText(/plays without transposing/)).toBeVisible();
  });

  test("bypass switches between transposed and original (AC-7)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const { page, panel } = await playingAt(context, worker, extensionId, 2);
    await expectFrequency(page, shifted(440, 2));
    await panel.getByRole("button", { name: "Bypass" }).click();
    await expectFrequency(page, 440);
    expect((await probe(page)).addedMs ?? Infinity).toBeLessThanOrEqual(20);
    await panel.getByRole("button", { pressed: true }).click();
    await expectFrequency(page, shifted(440, 2));
  });

  test("the next video keeps the transpose and clears the key; an ad keeps both (AC-8)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const { page, panel } = await playingAt(context, worker, extensionId, 2);
    await panel.getByLabel("Tonic").selectOption("G");
    await expect(panel.getByText("G major → A major (+2)")).toBeVisible();
    await page.click("#ad");
    await expectFrequency(page, shifted(550, 2));
    expect((await probe(page)).settings.key).toEqual({
      tonic: "G",
      mode: "major",
    });
    await page.click("#next");
    await expectFrequency(page, shifted(660, 2));
    await expect.poll(() => probe(page).then((p) => p.settings.key)).toBeNull();
    expect((await probe(page)).settings.semitones).toBe(2);
    await expect(panel.getByText("Now:").locator("..")).toHaveText("Now: +2");
  });

  test("a reload keeps the transpose and closing the tab forgets it (AC-9)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const { page } = await playingAt(context, worker, extensionId, 3);
    const tabId = await tabIdOf(worker, page);
    const session = () =>
      worker.evaluate(async () => {
        const { chrome } = globalThis as unknown as SwGlobals;
        return chrome.storage.session.get(null);
      });
    await expect.poll(session).toHaveProperty(`tab:${String(tabId)}`);
    await page.reload();
    await expect
      .poll(() => readProbe(page).then((p) => p?.settings.semitones))
      .toBe(3);
    await page.click("#play");
    await expectFrequency(page, shifted(440, 3));
    await page.close();
    await expect.poll(session).not.toHaveProperty(`tab:${String(tabId)}`);
  });

  test("two tabs keep independent transposes (AC-9)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const a = await playingAt(context, worker, extensionId, 2);
    const b = await playingAt(
      context,
      worker,
      extensionId,
      -3,
      "https://www.youtube.com/watch?v=ccccccccccc&f=660",
    );
    await expectFrequency(a.page, shifted(440, 2));
    await expectFrequency(b.page, shifted(660, -3));
    expect((await probe(a.page)).settings.semitones).toBe(2);
  });

  test("shortcuts change the active YouTube tab (AC-11)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const { page } = await playingAt(context, worker, extensionId, 2);
    await page.bringToFront();
    const press = (name: string) =>
      worker.evaluate(
        (command) => (globalThis as unknown as SwGlobals).pblShortcut(command),
        name,
      );
    const settings = () => probe(page).then((p) => p.settings);
    await press("transpose-up");
    await expect.poll(settings).toMatchObject({ semitones: 3 });
    await press("transpose-down");
    await expect.poll(settings).toMatchObject({ semitones: 2 });
    await press("toggle-bypass");
    await expect.poll(settings).toMatchObject({ bypass: true });
    await press("toggle-bypass");
    await press("transpose-reset");
    await expect.poll(settings).toMatchObject({ semitones: 0, bypass: false });
    await expectFrequency(page, 440);
  });

  test("works on YouTube Music (FR-1)", async ({
    context,
    worker,
    extensionId,
  }) => {
    const { page } = await playingAt(
      context,
      worker,
      extensionId,
      -2,
      "https://music.youtube.com/watch?v=ddddddddddd",
    );
    expect((await probe(page)).site).toBe("music");
    await expectFrequency(page, shifted(440, -2));
  });
});
