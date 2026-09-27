// Serves the audio-engine test harness (e2e/engine/harness) for Playwright.
// Default (ENGINE_HARNESS_MODE unset): production build + `vite preview`, so
// the tests exercise the same minified bundle and worklet loading as the real
// app. ENGINE_HARNESS_MODE=dev uses the dev server instead. Build output and
// caches live under node_modules/ so nothing lands in the source tree.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const at = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));
const port = Number(process.env.ENGINE_HARNESS_PORT ?? "4317");

export default defineConfig({
  root: at("./harness"),
  cacheDir: at("../../node_modules/.cache/vite-engine-harness"),
  logLevel: "warn",
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    fs: { allow: [at("../..")] },
  },
  preview: { host: "127.0.0.1", port, strictPort: true },
  build: {
    outDir: at("../../node_modules/.cache/engine-harness-dist"),
    emptyOutDir: true,
  },
});
