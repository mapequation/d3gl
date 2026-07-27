// Shared wall-clock budget helper for the browser perf guards (#247).
//
// The per-frame guards (`*-perf.browser.test.ts`) assert generous wall-clock
// ceilings calibrated on a local dev machine's headless Chromium. CI runs the
// same guards on shared ubuntu runners under SwiftShader software GL, which is
// uniformly slower — so the browser perf tier scales every ceiling by a single
// environment-driven factor instead of loosening the local numbers.
//
// `__PERF_BUDGET_SCALE__` is substituted at transform time from the
// `PERF_BUDGET_SCALE` env var (see `define` in packages/d3gl/vitest.config.ts),
// mirroring the `__D3GL_VERSION__` pattern in src/core/version.ts. The `typeof`
// guard keeps unbundled / node-vitest imports working (no substitution → falls
// back to 1, i.e. the unchanged local budgets).
declare const __PERF_BUDGET_SCALE__: string;

/** The environment's budget multiplier (1 locally; >1 on slow CI runners). */
export const perfBudgetScale: number = (() => {
  const raw = typeof __PERF_BUDGET_SCALE__ === "string" ? __PERF_BUDGET_SCALE__ : "";
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n > 0 ? n : 1;
})();

/**
 * Scale a locally-calibrated wall-clock budget (ms) for the current
 * environment. Deterministic assertions (allocation counts, call counts,
 * pixel identity) must NOT go through this — only wall-clock ceilings and
 * test timeouts.
 */
export const perfBudget = (localMs: number): number => localMs * perfBudgetScale;
