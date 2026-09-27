// Playwright config. Projects:
//  - engine-<browser>: the audio engine's real-browser specs (e2e/engine),
//    against a harness page this config serves itself (see webServer).
//  - app-chromium: the full-stack happy path (e2e/*.spec.ts outside engine/),
//    only when E2E_BASE_URL points at a running stack.
//
// Environment:
//  PW_BROWSERS          engine browsers, default "chromium,firefox,webkit"
//  ENGINE_HARNESS_URL   use an already running harness instead of starting one
//  ENGINE_HARNESS_PORT  harness port (default 4317)
//  ENGINE_HARNESS_MODE  "preview" (default: production build) or "dev"
//  E2E_BASE_URL         enables the app project against that URL
//  CI                   retries, forbid .only, HTML report
//
// Artifacts go under node_modules/.cache/playwright (git-, docker- and
// prettier-ignored).
import { defineConfig, devices, type Project } from "@playwright/test";

/** An environment variable, with "" treated as unset. */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === "" ? undefined : value;
}

const CI = Boolean(env("CI"));
const OUT = "node_modules/.cache/playwright";

const harnessPort = env("ENGINE_HARNESS_PORT") ?? "4317";
const harnessUrl =
  env("ENGINE_HARNESS_URL") ?? `http://127.0.0.1:${harnessPort}`;
const harnessConfig = "--config e2e/engine/vite.config.ts";
const harnessCommand =
  env("ENGINE_HARNESS_MODE") === "dev"
    ? `node_modules/.bin/vite ${harnessConfig}`
    : `node_modules/.bin/vite build ${harnessConfig} && node_modules/.bin/vite preview ${harnessConfig}`;

const browserDevices: Record<string, string> = {
  chromium: "Desktop Chrome",
  firefox: "Desktop Firefox",
  webkit: "Desktop Safari",
};
const engineBrowsers = (env("PW_BROWSERS") ?? "chromium,firefox,webkit")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name in browserDevices);

const projects: Project[] = engineBrowsers.map((name) => ({
  name: `engine-${name}`,
  testDir: "./e2e/engine",
  use: { ...devices[browserDevices[name] ?? ""], baseURL: harnessUrl },
}));

const appBaseUrl = env("E2E_BASE_URL");
if (appBaseUrl) {
  projects.push({
    name: "app-chromium",
    testDir: "./e2e",
    testIgnore: "engine/**",
    use: { ...devices["Desktop Chrome"], baseURL: appBaseUrl },
  });
}

export default defineConfig({
  outputDir: `${OUT}/results`,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // audio timing tests are sensitive to CPU contention
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI
    ? [["list"], ["html", { outputFolder: `${OUT}/report`, open: "never" }]]
    : "list",
  projects,
  webServer:
    env("ENGINE_HARNESS_URL") || engineBrowsers.length === 0
      ? []
      : [
          {
            command: harnessCommand,
            url: harnessUrl,
            env: { ENGINE_HARNESS_PORT: harnessPort },
            reuseExistingServer: !CI,
            timeout: 120_000,
          },
        ],
});
