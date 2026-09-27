// Real-browser tests for the audio engine (§10 B): real Web Audio, the real
// Signalsmith Stretch worklet + WASM, served from a production build of the
// harness page (see e2e/engine/vite.config.ts).
import { expect, test, type Page } from "@playwright/test";

const SAMPLE_RATE = 44_100;

async function openHarness(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/");
  await page.waitForFunction(() => "harness" in window);
  expect(errors).toEqual([]);
}

function record(name: string, value: unknown): void {
  const description = JSON.stringify(value);
  test.info().annotations.push({ type: name, description });
  console.log(`[${test.info().project.name}] ${name}: ${description}`);
}

function expectNear(actual: number, expected: number, tolerance: number): void {
  expect(actual).toBeGreaterThanOrEqual(expected - tolerance);
  expect(actual).toBeLessThanOrEqual(expected + tolerance);
}

test.describe("offline render", () => {
  test("shifts a 440 Hz tone to the expected pitch at the original length", async ({
    page,
  }) => {
    await openHarness(page);
    const results = await page.evaluate(async (sampleRate) => {
      const h = window.harness;
      const engine = h.createAudioEngine();
      await engine.load(
        h.signalUrl({
          seconds: 4,
          sampleRate,
          channels: 2,
          segments: [{ start: 0, end: 4, freq: 440 }],
        }),
      );
      const source = engine.audioBuffer;
      if (!source) throw new Error("nothing loaded");
      // The estimator's reading of the unprocessed source, for calibration.
      const sourceFreq = h.dominantFrequency(source, 1, 3);
      const out = [];
      for (const semitones of [0, 12, -12, 2]) {
        const started = performance.now();
        const r = await engine.renderOffline({ semitones, cents: 0 });
        out.push({
          semitones,
          freq: h.dominantFrequency(r, 1, 3),
          sourceFreq,
          length: r.length,
          sourceLength: source.length,
          seconds: r.duration,
          sampleRate: r.sampleRate,
          sourceRate: source.sampleRate,
          channels: r.numberOfChannels,
          ms: Math.round(performance.now() - started),
        });
      }
      engine.dispose();
      return out;
    }, SAMPLE_RATE);

    record("pitch", results);
    for (const r of results) {
      const expected = 440 * 2 ** (r.semitones / 12);
      expectNear(r.freq, expected, expected * 0.005); // ±0.5 %
      expect(r.length).toBe(r.sourceLength);
      expect(r.sampleRate).toBe(r.sourceRate);
      expect(r.channels).toBe(2);
    }
  });

  test("keeps tempo at 1.0 for ±12: a 60 s timeline stays aligned", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openHarness(page);
    const results = await page.evaluate(async (sampleRate) => {
      const h = window.harness;
      const engine = h.createAudioEngine();
      const marks = [1, 30, 58];
      await engine.load(
        h.signalUrl({
          seconds: 60,
          sampleRate,
          channels: 1,
          segments: marks.map((start) => ({
            start,
            end: start + 1,
            freq: 440,
          })),
        }),
      );
      const source = engine.audioBuffer;
      if (!source) throw new Error("nothing loaded");
      const out = [];
      for (const semitones of [12, -12]) {
        const r = await engine.renderOffline({ semitones, cents: 0 });
        out.push({
          semitones,
          seconds: r.duration,
          sourceSeconds: source.duration,
          source: h.bursts(source),
          rendered: h.bursts(r),
        });
      }
      engine.dispose();
      return out;
    }, SAMPLE_RATE);

    record("tempo", results);
    for (const r of results) {
      expect(r.seconds).toBe(r.sourceSeconds);
      expect(r.rendered).toHaveLength(3);
      expect(r.source).toHaveLength(3);
      r.rendered.forEach((b, i) => {
        const s = r.source[i];
        if (!s) throw new Error("missing source burst");
        expectNear(b.onset, s.onset, 0.03);
        expectNear(b.offset, s.offset, 0.03);
      });
      // No drift: first onset to last offset spans the same time as the source.
      const span = (xs: { onset: number; offset: number }[]): number =>
        (xs.at(-1)?.offset ?? Number.NaN) - (xs[0]?.onset ?? Number.NaN);
      expectNear(span(r.rendered), span(r.source), 0.02);
    }
  });

  test("reports progress from 0 to 100", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(async (sampleRate) => {
      const h = window.harness;
      const engine = h.createAudioEngine();
      await engine.load(
        h.signalUrl({
          seconds: 20,
          sampleRate,
          channels: 2,
          segments: [{ start: 0, end: 20, freq: 330 }],
        }),
      );
      const pct: number[] = [];
      await engine.renderOffline({
        semitones: 5,
        cents: 0,
        onProgress: (p) => pct.push(p),
      });
      engine.dispose();
      return { pct, suspend: h.offlineSuspendSupported };
    }, SAMPLE_RATE);

    record("progress", result);
    expect(result.pct[0]).toBe(0);
    expect(result.pct.at(-1)).toBe(100);
    expect(result.pct.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < result.pct.length; i++) {
      expect(result.pct[i]).toBeGreaterThan(result.pct[i - 1] ?? -1);
    }
  });
});

test("encodeWav output decodes back with the same length and two channels", async ({
  page,
}) => {
  await openHarness(page);
  const results = await page.evaluate(async (sampleRate) => {
    const h = window.harness;
    const out = [];
    for (const channels of [1, 2]) {
      const source = h.signalBuffer({
        seconds: 1.5,
        sampleRate,
        channels,
        segments: [{ start: 0, end: 1.5, freq: 1000, amp: 0.9 }],
      });
      if (channels === 2) {
        const right = source.getChannelData(1);
        right.forEach((v, i) => (right[i] = -v * 0.5));
      }
      const left = source.getChannelData(0);
      left[100] = 1.7; // clips to +1
      left[101] = -3; // clips to -1
      const bytes = await h.encodeWav(source).arrayBuffer();
      const byteLength = bytes.byteLength; // decodeAudioData detaches `bytes`
      const ctx = new OfflineAudioContext(1, 1, sampleRate);
      const decoded = await ctx.decodeAudioData(bytes);
      let maxError = 0;
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        const got = decoded.getChannelData(c);
        const want = source.getChannelData(Math.min(c, channels - 1));
        for (let i = 0; i < got.length; i++) {
          const expected = Math.max(-1, Math.min(1, want[i] ?? 0));
          maxError = Math.max(maxError, Math.abs((got[i] ?? 0) - expected));
        }
      }
      out.push({
        channels,
        bytes: byteLength,
        length: decoded.length,
        sourceLength: source.length,
        decodedChannels: decoded.numberOfChannels,
        sampleRate: decoded.sampleRate,
        maxError,
      });
    }
    return out;
  }, SAMPLE_RATE);

  record("wav", results);
  for (const r of results) {
    expect(r.bytes).toBe(44 + r.sourceLength * 4);
    expect(r.length).toBe(r.sourceLength);
    expect(r.decodedChannels).toBe(2);
    expect(r.sampleRate).toBe(SAMPLE_RATE);
    // 16-bit quantization, plus decoder scaling differences (WebKit divides
    // by 32767): within 2 LSB. Byte-exact output is covered by unit tests.
    expect(r.maxError).toBeLessThanOrEqual(2 / 32768);
  }
});

test.describe("realtime playback", () => {
  test.beforeEach(async ({ page, browserName }) => {
    await openHarness(page);
    if (browserName !== "firefox") return; // the others must always work
    await page.click("#probe");
    const works = await page.evaluate(() =>
      window.harness.realtimeAudioWorks(),
    );
    test.skip(
      !works,
      "Firefox can't start a realtime AudioContext without an audio device (Docker/CI); its offline tests still run",
    );
  });

  async function loadTone(
    page: Page,
    seconds: number,
    freq = 440,
  ): Promise<number[]> {
    return page.evaluate(
      async ({ seconds, freq, sampleRate }) => {
        const h = window.harness;
        const pct: number[] = [];
        await h.engine.load(
          h.signalUrl({
            seconds,
            sampleRate,
            channels: 2,
            segments: [{ start: 0, end: seconds, freq }],
          }),
          (p) => pct.push(p),
        );
        return pct;
      },
      { seconds, freq, sampleRate: SAMPLE_RATE },
    );
  }

  const state = (page: Page) =>
    page.evaluate(() => {
      const { engine, log } = window.harness;
      return {
        t: engine.currentTime,
        playing: engine.isPlaying,
        duration: engine.duration,
        ticks: log.filter((e) => e.event === "timeupdate").length,
        ended: log.filter((e) => e.event === "ended").length,
        errors: log.filter((e) => e.event === "error").map((e) => e.message),
      };
    });

  test("load → play → currentTime advances → pause stops it", async ({
    page,
  }) => {
    const pct = await loadTone(page, 6);
    expect(pct[0]).toBe(0);
    expect(pct.at(-1)).toBe(100);
    expect((await state(page)).duration).toBeCloseTo(6, 3);

    await page.click("#play"); // a real gesture resumes the AudioContext
    await page.waitForTimeout(1500);
    const playing = await state(page);
    await page.click("#pause");
    const paused = await state(page);
    await page.waitForTimeout(500);
    const later = await state(page);

    record("transport", { pct, playing, paused, later });
    expect(playing.errors).toEqual([]);
    expect(playing.playing).toBe(true);
    expect(playing.t).toBeGreaterThan(1);
    expect(playing.t).toBeLessThan(2.5);
    expect(playing.ticks).toBeGreaterThanOrEqual(5);
    expect(paused.playing).toBe(false);
    expect(later.t).toBe(paused.t);
  });

  test("live pitch changes are heard quickly without restarting playback", async ({
    page,
  }) => {
    await loadTone(page, 10);
    await page.click("#play");
    await page.waitForTimeout(700);
    const before = await page.evaluate(() => ({
      f: window.harness.liveFrequency(),
      t: window.harness.engine.currentTime,
    }));
    const change = await page.evaluate(async () => {
      const h = window.harness;
      const started = performance.now();
      h.engine.setSemitones(12);
      for (;;) {
        const f = h.liveFrequency();
        const ms = performance.now() - started;
        if (f !== null && Math.abs(f - 880) < 15) return { ms, f };
        if (ms > 2000) return { ms: Number.POSITIVE_INFINITY, f };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      f: window.harness.liveFrequency(),
      t: window.harness.engine.currentTime,
      playing: window.harness.engine.isPlaying,
    }));

    record("live", { before, change, after });
    expectNear(before.f ?? 0, 440, 15);
    expectNear(after.f ?? 0, 880, 15);
    // Measured at the node output; includes the analyser's 85 ms window and polling.
    expect(change.ms).toBeLessThan(500);
    expect(after.playing).toBe(true);
    expect(after.t).toBeGreaterThan(before.t + 0.25); // no restart from 0
  });

  test("fires ended at the end of the track, on time", async ({ page }) => {
    await loadTone(page, 2);
    const started = Date.now();
    await page.click("#play");
    await page.waitForFunction(
      () => window.harness.log.some((e) => e.event === "ended"),
      undefined,
      { timeout: 10_000 },
    );
    const wallSeconds = (Date.now() - started) / 1000;
    const s = await state(page);
    record("ended", { wallSeconds, ...s });
    expect(s.ended).toBe(1);
    expect(s.playing).toBe(false);
    expect(s.t).toBe(s.duration);
    expectNear(wallSeconds, 2, 0.6);
  });

  test("dispose, then load again on the same engine, plays", async ({
    page,
  }) => {
    await loadTone(page, 5);
    await page.click("#play");
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.harness.engine.dispose();
    });
    expect((await state(page)).playing).toBe(false);
    await loadTone(page, 5, 550);
    await page.click("#play");
    await page.waitForTimeout(800);
    const s = await state(page);
    record("reload", s);
    expect(s.playing).toBe(true);
    expect(s.t).toBeGreaterThan(0.4);
    expect(s.errors).toEqual([]);
  });
});
