import { defineConfig, configDefaults } from "vitest/config";

// Two node projects, run as two sequential groups (#257).
//
// The perf guards assert wall-clock ceilings calibrated for an **uncontended** run. Sharing the
// pool with the rest of the suite broke that: parallel workers steal cycles from the timed
// sections, inflating this repo's total test time 4.2× (14.1s serial vs 58.7s parallel) and
// intermittently tripping budgets in `frontier-perf`, `super-edges-perf` and friends — reproduced
// across four sessions, and on unmodified `main`, so it was contention, never a regression.
//
// Loosening the budgets was rejected: the overshoot is unbounded (6-7× observed under an external
// load spike), so any fixed multiplier is either flaky or too slack to catch anything. Instead the
// guards get the machine to themselves. `groupOrder` puts them in a later group than the unit
// tests, so the two never overlap, and `fileParallelism: false` keeps them from contending with
// each other. Budgets stay exactly as calibrated, in every environment.
//
// Discovery is **pattern-driven**, matching the two existing perf tiers: a node test named
// `*-perf.test.ts` or `*.bench.test.ts` under `packages/*/src` is enrolled automatically. Name a
// new wall-clock guard accordingly and it lands in the serial group with no config change.
const PERF_GUARDS = ["packages/*/src/**/*-perf.test.ts", "packages/*/src/**/*.bench.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          // Node-environment unit tests. Browser tests (*.browser.test.ts) run only via
          // each package's own browser config (e.g. packages/webgl/vitest.config.ts).
          include: ["packages/*/src/**/*.test.ts", "website/src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.browser.test.ts", ...PERF_GUARDS],
          environment: "node",
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "perf",
          include: PERF_GUARDS,
          exclude: [...configDefaults.exclude, "**/*.browser.test.ts"],
          environment: "node",
          // Alone, and one file at a time: what the calibrated ceilings assume.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          // These build 100k-1M-element fixtures; vitest's 5s default is a harness limit that a
          // loaded machine trips long before any calibrated ceiling has an opinion. Raising it
          // removes that failure mode without touching a single budget — a timeout is not an
          // assertion. Real overruns are still caught: by the ceilings here, and by
          // PERF_FILE_BUDGET_MS in the CI tier.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
