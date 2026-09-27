// §10 C9: the one full-stack happy path. Upload → play → shift +2 → export,
// against the real stack (api, worker, valkey, media, web). Runs as the
// `app-chromium` project when E2E_BASE_URL points at that stack.
//
// The fixture is a generated 6 s C–F–G–C progression, so the detected key is
// known: C major, and +2 semitones is D major.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const fixture = fileURLToPath(
  new URL("./fixtures/c-major-progression.mp3", import.meta.url),
);

test("upload, play, transpose +2 and download the WAV", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Audio file").setInputFiles(fixture);

  // The player appears at audio_ready, before the key is known (§6.5).
  const play = page.getByRole("button", { name: "Play" });
  await expect(play).toBeVisible({ timeout: 60_000 });

  // Key detection finishes shortly after and lands on the fixture's key.
  const original = page.locator(".key-line", { hasText: "Original:" });
  await expect(original).toContainText("C major", { timeout: 60_000 });

  await play.click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();

  // Two steps up on the dial: live, client-side, no reload.
  const dial = page.getByRole("slider", { name: "Transpose" });
  await dial.focus();
  await dial.press("ArrowRight");
  await dial.press("ArrowRight");
  await expect(dial).toHaveAttribute("aria-valuenow", "2");
  await expect(dial).toHaveAttribute(
    "aria-valuetext",
    /Plus 2 semitones, D major/,
  );
  await expect(
    page.locator(".key-line--now", { hasText: "Now:" }),
  ).toContainText("D major");

  // Export renders offline and downloads a WAV named after the new key.
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Download WAV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "c-major-progression (D major, +2).wav",
  );

  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
  // 16-bit stereo; the tempo is unchanged, so still ~6 s of audio.
  const seconds = (bytes.length - 44) / (2 * 2 * bytes.readUInt32LE(24));
  expect(seconds).toBeGreaterThan(5.8);
  expect(seconds).toBeLessThan(6.3);
});
