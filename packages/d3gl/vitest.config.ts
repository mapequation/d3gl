import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

// Browser-mode suites for the GPU / DOM / React modules. The CPU modules test
// in Node via the root vitest config; these *.browser.test.{ts,tsx} run only
// here, in headless Chromium.

// Wall-clock budget multiplier for slow environments (the CI browser perf tier
// runs on shared runners under SwiftShader software GL — see #247 and
// src/__tests__/perf-budget.ts). Unset ⇒ 1 ⇒ local budgets/timeouts unchanged.
const rawScale = Number(process.env.PERF_BUDGET_SCALE);
const budgetScale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;

export default defineConfig({
  oxc: { transform: { react: {} } },
  // Substituted into test sources at transform time (the __D3GL_VERSION__
  // pattern) so browser-side perf guards can scale their wall-clock ceilings
  // via src/__tests__/perf-budget.ts.
  define: {
    __PERF_BUDGET_SCALE__: JSON.stringify(String(budgetScale)),
    // Fixture scale for the browser guards (#262). Separate from the node tier's PERF_N:
    // CI renders under SwiftShader software GL, so the browser tier picks its own N.
    // Unset ⇒ "" ⇒ each guard keeps its locally-calibrated default.
    __PERF_N__: JSON.stringify(process.env.PERF_BROWSER_N ?? ""),
  },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    // Bound the in-test / hook / global-teardown phases so a stalled WebGL
    // device or a browser that won't close fails fast instead of hanging.
    // The wall-clock watchdog in scripts/run-browser-tests.mjs covers the
    // phases Vitest itself can't time out (browser launch, vite optimizer).
    // These scale with the budget multiplier — software GL is slower at
    // everything, not just the sweeps the guards assert on.
    testTimeout: 20_000 * budgetScale,
    hookTimeout: 20_000 * budgetScale,
    teardownTimeout: 15_000 * budgetScale,
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
