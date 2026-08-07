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

// ---- fixture scale for the browser guards (#262) ------------------------------------------------
//
// The node tier drives its benches at `$PERF_N` (scripts/run-perf-tier.mjs sets each
// `BENCH_<NAME>_N`). The browser guards had no equivalent: their fixture sizes were hardcoded at
// 100-100k, so the browser tier always measured a small scene no matter what CI asked for — and
// WebGL is the DEFAULT backend, i.e. the least-gated path had the least scale behind it.
//
// `__PERF_N__` is substituted at transform time from `PERF_BROWSER_N` (see `define` in
// packages/d3gl/vitest.config.ts), the same mechanism as `__PERF_BUDGET_SCALE__` above — browser
// tests cannot read `process.env`. It is deliberately a SEPARATE variable from the node tier's
// `PERF_N`: CI renders through SwiftShader software GL, where the node tier's 500k would blow the
// per-file budget on geometry upload alone.
declare const __PERF_N__: string;

/** The tier's requested fixture size, or 0 when unset (each guard then keeps its local default). */
export const perfNOverride: number = (() => {
  const raw = typeof __PERF_N__ === "string" ? __PERF_N__ : "";
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
})();

/**
 * Resolve a guard's fixture size: the tier's scale when it asked for one, else the local default.
 *
 * Use this for the **input size** only. A wall-clock ceiling that must grow with it goes through
 * {@link perfBudget} *and* scales on `n / localDefault`; a deterministic signature (allocation
 * counts, renderer-construction counts, buffer identity, pixel equality) must stay exactly as it
 * is — those are the assertions that hold at every scale, and scaling one would defeat the guard.
 *
 * `max` is the largest N **this particular leg** can survive, and is not optional thinking: a
 * single unclamped tier N applied to every guard hits a different hard wall in each one. Known
 * walls, all found while wiring #262:
 *   - the WebGL style tables are a 256-wide `GrowTexture`, so N > ~2.1M needs more rows than
 *     `MAX_TEXTURE_SIZE` allows and `createTexture` fails at `setLayers` — an error, not a budget;
 *   - the SVG export leg materialises one DOM node per drawable;
 *   - a guard holding two live charts doubles its own fixture.
 * Clamping is not loosening — the assertions still hold exactly at whatever N comes back.
 */
export const perfN = (localDefault: number, opts?: { max?: number }): number => {
  if (perfNOverride <= 0) return localDefault;
  const max = opts?.max;
  return max !== undefined && perfNOverride > max ? max : perfNOverride;
};
