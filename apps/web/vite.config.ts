/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server runs two ways (ADR 0004):
//  - `make dev`: on the host. The defaults below keep it on localhost and proxy to
//    the host-native API (:8000) and the /media nginx container (:8081).
//  - `make up`: inside Docker Compose, which sets these variables to 0.0.0.0 and
//    the Compose service names (api, media).
const host = process.env.DEV_SERVER_HOST ?? "127.0.0.1";
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000";
const mediaTarget = process.env.MEDIA_PROXY_TARGET ?? "http://127.0.0.1:8081";

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
      "/media": mediaTarget,
    },
    // File events from macOS bind mounts are unreliable; poll when asked to.
    watch:
      process.env.CHOKIDAR_USEPOLLING === "true"
        ? { usePolling: true }
        : undefined,
  },
  preview: {
    host,
    port: 4173,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
