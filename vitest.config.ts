import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Node-environment unit tests. Browser tests (*.browser.test.ts) run only via
    // each package's own browser config (e.g. packages/webgl/vitest.config.ts).
    include: ["packages/*/src/**/*.test.ts", "website/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.browser.test.ts"],
    environment: "node",
  },
});
