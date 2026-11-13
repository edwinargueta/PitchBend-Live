// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Builds the Chrome extension into dist-extension/ (load it unpacked from
// there). Two parts, because a content script must be one classic script:
//  - pages (default): side panel + service worker as ES modules, plus
//    manifest.json and the unchanged signalsmith-stretch .mjs (stretchLoader.ts).
//  - EXTENSION_PART=content: content/main.ts as a single IIFE, content.js.
// `--mode probe` builds the e2e variant (test probe compiled in) under
// node_modules/.cache/, so it can never be mistaken for the real build.
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const at = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

function extensionAssets(): Plugin {
  return {
    name: "pitchbend-extension-assets",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: readFileSync(at("./src/extension/manifest.json"), "utf8"),
      });
      this.emitFile({
        type: "asset",
        fileName: "vendor/signalsmith-stretch.mjs",
        source: readFileSync(
          at("./node_modules/signalsmith-stretch/SignalsmithStretch.mjs"),
          "utf8",
        ),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const outDir =
    mode === "probe"
      ? at("./node_modules/.cache/extension-probe-dist")
      : at("./dist-extension");
  const common = {
    cacheDir: at("./node_modules/.cache/vite-extension"),
    publicDir: false as const,
    logLevel: "warn" as const,
  };

  if (process.env.EXTENSION_PART === "content") {
    return {
      ...common,
      build: {
        outDir,
        emptyOutDir: false,
        sourcemap: false,
        lib: {
          entry: at("./src/extension/content/main.ts"),
          formats: ["iife" as const],
          name: "PitchBendLiveContent",
          fileName: () => "content.js",
        },
      },
    };
  }

  return {
    ...common,
    root: at("./src/extension"),
    plugins: [react(), extensionAssets()],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          panel: at("./src/extension/panel/index.html"),
          "service-worker": at("./src/extension/background/main.ts"),
        },
        output: {
          entryFileNames: (chunk: { name: string }) =>
            chunk.name === "service-worker"
              ? "service-worker.js"
              : "assets/[name]-[hash].js",
        },
      },
    },
  };
});
