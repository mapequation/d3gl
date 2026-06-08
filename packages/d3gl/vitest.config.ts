import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

// Browser-mode suites for the GPU / DOM / React modules. The CPU modules test
// in Node via the root vitest config; these *.browser.test.{ts,tsx} run only
// here, in headless Chromium.
export default defineConfig({
  oxc: { transform: { react: {} } },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    // Bound the in-test / hook / global-teardown phases so a stalled WebGL
    // device or a browser that won't close fails fast instead of hanging.
    // The wall-clock watchdog in scripts/run-browser-tests.mjs covers the
    // phases Vitest itself can't time out (browser launch, vite optimizer).
    testTimeout: 20_000,
    hookTimeout: 20_000,
    teardownTimeout: 15_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      // The recurring hang is the browser launching but never connecting back
      // (run sits at "Test Files 0 passed (N)" forever). Bound that phase so it
      // fails with a clear connection error instead of climbing indefinitely.
      connectTimeout: 30_000,
      instances: [{ browser: "chromium" }],
    },
  },
});
