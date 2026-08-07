#!/usr/bin/env node
// Browser perf-guard tier (#247): run every browser-side per-frame perf guard headless
// (Playwright Chromium — SwiftShader software GL on CI runners), so the GPU-path
// regressions the node tier (#220, scripts/run-perf-tier.mjs) can't see — per-frame
// buffer recreates, texture-upload churn, renderer reconstruction — actually execute
// (and fail) in CI.
//
// DISCOVERY IS PATTERN-DRIVEN, not a hard-coded list: any `*-perf.browser.test.ts(x)`
// (or a bare `perf.browser.test.ts(x)`) under packages/*/src is part of the tier. A
// merged PR that adds a new browser perf guard following the naming convention is
// picked up automatically on the next run.
//
// Each file runs in its own process through the package's wall-clock watchdog runner
// (packages/<pkg>/scripts/run-browser-tests.mjs), which turns the browser suite's known
// stall modes (browser launch, vite optimizer, leaked-WebGL teardown) into fast
// failures. Isolation also keeps one guard's leaked GL context from skewing the next.
//
// Budgets: the guards' wall-clock ceilings are calibrated on local headless Chromium.
// $PERF_BUDGET_SCALE (default 1 = local budgets) multiplies every ceiling and test
// timeout — see packages/d3gl/src/__tests__/perf-budget.ts and the `define` in
// packages/d3gl/vitest.config.ts. CI sets it for the slower shared-runner SwiftShader.
// Deterministic assertions (allocation/call counts, pixel identity) never scale.
//
// The runner also enforces a hard per-file wall-clock budget
// ($PERF_BROWSER_FILE_BUDGET_MS, default 300000 = 5 min, passed to the watchdog): a
// file that exceeds it is killed and FAILS the tier — the pattern-level guard against
// hangs and order-of-magnitude regressions that dodge the in-test ceilings.
//
// Usage:
//   node scripts/run-browser-perf-tier.mjs                     # local (scale 1)
//   PERF_BUDGET_SCALE=8 node scripts/run-browser-perf-tier.mjs # the CI invocation
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE_BUDGET_MS = Number(process.env.PERF_BROWSER_FILE_BUDGET_MS) || 300_000;
const SCALE = process.env.PERF_BUDGET_SCALE ?? "1";
// Fixture scale for the guards (#262), reaching them through the __PERF_N__ define in
// packages/d3gl/vitest.config.ts — browser tests cannot read process.env. Deliberately its own
// variable rather than the node tier's PERF_N: that tier runs at 500k, which under SwiftShader
// software GL would spend the whole per-file budget on geometry upload. Unset ⇒ each guard's
// locally-calibrated default, i.e. the pre-#262 behaviour.
const BROWSER_N = process.env.PERF_BROWSER_N ?? "";

// The browser perf-guard naming convention: `<name>-perf.browser.test.ts(x)` or a
// bare `perf.browser.test.ts(x)`.
const PERF_FILE_RE = /(^|-)perf\.browser\.test\.tsx?$/;

/** Recursively collect browser perf-guard files (node benches run in their own tier). */
function perfFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...perfFiles(p));
    else if (PERF_FILE_RE.test(e.name)) out.push(p);
  }
  return out;
}

/** All packages/<pkg> dirs that have a src/. */
function packageDirs() {
  const pkgs = join(root, "packages");
  return readdirSync(pkgs)
    .map((p) => join(pkgs, p))
    .filter((p) => { try { return statSync(join(p, "src")).isDirectory(); } catch { return false; } });
}

// ---- discover: package dir → its perf-guard browser files ---------------------------
const guards = [];
for (const pkgDir of packageDirs()) {
  for (const file of perfFiles(join(pkgDir, "src"))) guards.push({ pkgDir, file });
}
guards.sort((a, b) => a.file.localeCompare(b.file));

if (guards.length === 0) {
  console.error("browser perf tier: no *-perf.browser.test.ts guards found under packages/*/src — discovery is broken");
  process.exit(1);
}

console.log(
  `browser perf tier: ${guards.length} guard file(s), PERF_BUDGET_SCALE=${SCALE}, ` +
    `PERF_BROWSER_N=${BROWSER_N || "(guard defaults)"}, budget ${FILE_BUDGET_MS}ms/file`,
);
for (const { file } of guards) console.log(`  ${relative(root, file)}`);

// ---- run each file through its package's watchdog runner, timed ---------------------
const env = { ...process.env, PERF_BUDGET_SCALE: SCALE, PERF_BROWSER_N: BROWSER_N };
const results = [];
for (const { pkgDir, file } of guards) {
  const watchdog = join(pkgDir, "scripts", "run-browser-tests.mjs");
  const rel = relative(root, file);
  console.log(`\n=== ${rel} ===`);
  if (!existsSync(watchdog)) {
    // A perf guard in a package without the watchdog runner can't be executed — that's
    // a broken enrolment, not something to skip silently.
    console.error(`browser perf tier: ${rel} has no ${relative(root, watchdog)} to run it`);
    results.push({ rel, ms: 0, ok: false, timedOut: false });
    continue;
  }
  const t0 = Date.now();
  // The watchdog kills its whole process group (vitest + Chromium) at the budget; the
  // spawnSync timeout is a belt-and-braces backstop should the watchdog itself wedge.
  const r = spawnSync(process.execPath, [watchdog, relative(pkgDir, file), `--watchdog-timeout=${FILE_BUDGET_MS}`], {
    cwd: pkgDir,
    env,
    stdio: "inherit",
    timeout: FILE_BUDGET_MS + 30_000,
    killSignal: "SIGKILL",
  });
  const ms = Date.now() - t0;
  const timedOut = r.error?.code === "ETIMEDOUT" || r.status === 124;
  const ok = !timedOut && r.status === 0;
  results.push({ rel, ms, ok, timedOut });
}

// ---- summary -------------------------------------------------------------------------
console.log("\nbrowser perf tier summary");
let failed = false;
for (const { rel, ms, ok, timedOut } of results) {
  const state = ok ? "PASS" : timedOut ? `FAIL (killed at ${FILE_BUDGET_MS}ms budget)` : "FAIL";
  if (!ok) failed = true;
  console.log(`  ${state.padEnd(6)} ${(ms / 1000).toFixed(1).padStart(7)}s  ${rel}`);
}
process.exit(failed ? 1 : 0);
