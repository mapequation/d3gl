---
"@mapequation/d3gl": patch
---

Test infrastructure: browser perf-guard tier in CI (#247). The `*-perf.browser.test.ts` per-frame guards now run headless in CI (advisory job `perf-browser`, pattern-discovered by `scripts/run-browser-perf-tier.mjs`), with their locally-calibrated wall-clock ceilings scaled for software-GL runners via `PERF_BUDGET_SCALE` (`src/__tests__/perf-budget.ts`). No library runtime changes.
