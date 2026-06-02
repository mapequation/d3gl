import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

// Browser-mode suites for the GPU / DOM / React modules. The CPU modules test
// in Node via the root vitest config; these *.browser.test.{ts,tsx} run only
// here, in headless Chromium.
export default defineConfig({
  oxc: { transform: { react: {} } },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
