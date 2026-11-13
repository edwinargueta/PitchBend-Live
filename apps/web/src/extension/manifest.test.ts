// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// AC-13 (and FR-1, FR-4): the manifest asks for exactly what the spec allows,
// and the extension's source has no network, download or persistent-storage
// calls. These are the promises behind "nothing is downloaded or sent".
import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";
import { STRETCH_MODULE_PATH } from "./content/stretchLoader";
import { SHORTCUTS } from "./background/serviceWorker";
import { YOUTUBE_ORIGINS } from "./shared/protocol";

const MATCHES = ["https://www.youtube.com/*", "https://music.youtube.com/*"];

describe("manifest.json", () => {
  it("should be Manifest V3 with exactly two permissions", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["sidePanel", "storage"]);
  });

  it("should reach only the two YouTube origins", () => {
    expect(manifest.host_permissions).toEqual(MATCHES);
    expect(YOUTUBE_ORIGINS.map((origin) => `${origin}*`)).toEqual(MATCHES);
  });

  it("should inject one content script on those origins", () => {
    expect(manifest.content_scripts).toEqual([
      { matches: MATCHES, js: ["content.js"], run_at: "document_idle" },
    ]);
  });

  it("should expose only the packaged pitch shifter, only to YouTube", () => {
    expect(manifest.web_accessible_resources).toEqual([
      { resources: [STRETCH_MODULE_PATH], matches: MATCHES },
    ]);
  });

  it("should keep the default extension CSP (no remote code)", () => {
    expect(manifest).not.toHaveProperty("content_security_policy");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest).not.toHaveProperty("optional_permissions");
  });

  it("should declare the four shortcuts the worker handles (AC-11)", () => {
    expect(Object.keys(manifest.commands).sort()).toEqual(
      [...SHORTCUTS.keys()].sort(),
    );
    for (const command of Object.values(manifest.commands)) {
      expect(command.suggested_key.default).toMatch(/^Alt\+Shift\+/);
    }
  });

  it("should point at the files the build emits", () => {
    expect(manifest.background).toEqual({
      service_worker: "service-worker.js",
      type: "module",
    });
    expect(manifest.side_panel.default_path).toBe("panel/index.html");
  });
});

/** Every non-test source file of the extension, as text. */
const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./testing/**"],
  { query: "?raw", import: "default", eager: true },
);

const FORBIDDEN: readonly [string, RegExp][] = [
  ["fetch()", /\bfetch\s*\(/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["WebSocket", /WebSocket/],
  ["sendBeacon", /sendBeacon/],
  ["EventSource", /EventSource/],
  ["chrome.downloads", /\.downloads\b/],
  ["storage.local / storage.sync", /storage\.(local|sync)\b/],
  ["document.cookie", /document\.cookie/],
  ["innerHTML", /innerHTML/],
  ["eval / new Function", /\beval\s*\(|new\s+Function\s*\(/],
  ["MediaRecorder (recording)", /MediaRecorder/],
];

describe("extension source (AC-13, AC-9)", () => {
  it("should include the content, worker and panel code", () => {
    const files = Object.keys(sources);
    expect(files).toContain("./content/controller.ts");
    expect(files).toContain("./background/serviceWorker.ts");
    expect(files).toContain("./panel/Panel.tsx");
  });

  it.each(FORBIDDEN)("should never use %s", (_label, pattern) => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => pattern.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
