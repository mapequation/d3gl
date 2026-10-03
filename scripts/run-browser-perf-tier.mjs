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
// SHARDS (#460): CI runs the tier as parallel jobs, one per shard of SHARDS below, each with
// its own 30-minute timeout, plus an aggregate `perf-browser` check that passes only when
// every shard does. A shard groups guards of one kind. A file goes to the FIRST shard whose
// pattern matches its repo-relative path, so it runs in exactly one shard. `--plan` (the CI
// matrix's source) fails when a perf file matches no shard, or a shard matches no file, so a
// guard can't silently drop out of CI. A new guard in an existing directory usually lands in
// a shard by its name; one in a new directory fails the plan until it gets a shard.
//
// Usage:
//   node scripts/run-browser-perf-tier.mjs                     # every guard, local (scale 1)
//   node scripts/run-browser-perf-tier.mjs --shard=nested      # one shard
//   node scripts/run-browser-perf-tier.mjs --plan              # shard → files; `shards=<json>` on stdout
//   PERF_BUDGET_SCALE=4 PERF_BROWSER_N=100000 node scripts/run-browser-perf-tier.mjs --shard=<name>  # a CI job
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

/**
 * The CI shards, by kind (#460). First match wins, so order matters: "nested" comes before
 * "gpu-layout", which would otherwise take the GPU nested guards. Balanced by measured CI time
 * (2026-10-03, ubuntu-latest, PERF_BROWSER_N=100000, guards only, about 40 s of job setup on
 * top): gpu-layout 6.6 min, nested 7.6, transitions 3.6, engines 6.5. Open PRs then add the
 * live-layout follow guard to transitions (#457, 1.5-4.7 min) and the spatial LOD cold start to
 * engines (#449, about 2 min).
 * `match` runs on the repo-relative path with forward slashes.
 */
const SHARDS = [
  {
    name: "nested",
    title: "Nested layouts: the GPU nested solve, its warm re-layout and interaction; the nested drag",
    match: /\/network\/(?:gpu\/)?__tests__\/(?:gpu|network)-nested-[^/]*$/,
  },
  {
    name: "gpu-layout",
    title: "GPU force layout: streaming, LOD relay, startup compile, frame budget, readback",
    match: /\/network\/gpu\/__tests__\/[^/]*$/,
  },
  {
    name: "transitions",
    title: "network() position transitions and live-layout following, on WebGL",
    // The Canvas/SVG transition guard (network-vector-transition) runs in "engines", for balance.
    match: /\/network\/__tests__\/network-(?!vector-)(?:[a-z0-9-]*-)?(?:transition|follow|fit-stream)-perf\.browser\.test\.tsx?$/,
  },
  {
    name: "engines",
    title: "network() LOD, zoom and interaction, and the Canvas/SVG network; map, WebGL and React backends",
    match: /\/(?:network\/__tests__|(?:map|webgl|react)(?:\/__tests__)?)\/[^/]*$/,
  },
];

/** The shard a guard runs in: the first whose pattern matches it, or undefined. */
const shardOf = (rel) => SHARDS.find((s) => s.match.test(`/${rel.split("\\").join("/")}`));

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

// ---- shards: every guard to the first shard that matches it ---------------------------
for (const g of guards) g.shard = shardOf(relative(root, g.file))?.name;
const unassigned = guards.filter((g) => g.shard === undefined).map((g) => relative(root, g.file));
const empty = SHARDS.filter((s) => !guards.some((g) => g.shard === s.name)).map((s) => s.name);
const shardProblems = [
  ...unassigned.map((rel) => `${rel} matches no shard: add it to a pattern in SHARDS (scripts/run-browser-perf-tier.mjs)`),
  ...empty.map((name) => `shard "${name}" matches no guard: its pattern is stale`),
];

const args = process.argv.slice(2);
const shardArg = args.find((a) => a.startsWith("--shard="))?.slice("--shard=".length);

if (args.includes("--plan")) {
  // The CI matrix's source of truth. The table goes to stderr (the job log); stdout carries only
  // the `shards=<json>` line for $GITHUB_OUTPUT.
  for (const s of SHARDS) {
    const files = guards.filter((g) => g.shard === s.name);
    console.error(`${s.name} (${files.length}): ${s.title}`);
    for (const g of files) console.error(`  ${relative(root, g.file)}`);
  }
  for (const p of shardProblems) console.error(`browser perf tier: ${p}`);
  if (shardProblems.length > 0) process.exit(1);
  console.log(`shards=${JSON.stringify(SHARDS.map((s) => s.name))}`);
  process.exit(0);
}

let selected = guards;
if (shardArg !== undefined) {
  if (!SHARDS.some((s) => s.name === shardArg)) {
    console.error(`browser perf tier: no shard "${shardArg}" (shards: ${SHARDS.map((s) => s.name).join(", ")})`);
    process.exit(1);
  }
  selected = guards.filter((g) => g.shard === shardArg);
  if (selected.length === 0) {
    console.error(`browser perf tier: shard "${shardArg}" matches no guard — its pattern is stale`);
    process.exit(1);
  }
} else {
  // A full local run still runs every guard; the plan step is CI's gate for these.
  for (const p of shardProblems) console.warn(`browser perf tier: warning: ${p}`);
}

console.log(
  `browser perf tier${shardArg ? ` [shard ${shardArg}]` : ""}: ${selected.length} guard file(s), PERF_BUDGET_SCALE=${SCALE}, ` +
    `PERF_BROWSER_N=${BROWSER_N || "(guard defaults)"}, budget ${FILE_BUDGET_MS}ms/file`,
);
for (const { file } of selected) console.log(`  ${relative(root, file)}`);

// ---- run each file through its package's watchdog runner, timed ---------------------
const env = { ...process.env, PERF_BUDGET_SCALE: SCALE, PERF_BROWSER_N: BROWSER_N };
const results = [];
for (const { pkgDir, file } of selected) {
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
console.log(`\nbrowser perf tier summary${shardArg ? ` [shard ${shardArg}]` : ""}`);
let failed = false;
const rows = [];
for (const { rel, ms, ok, timedOut } of results) {
  const state = ok ? "PASS" : timedOut ? `FAIL (killed at ${FILE_BUDGET_MS}ms budget)` : "FAIL";
  if (!ok) failed = true;
  console.log(`  ${state.padEnd(6)} ${(ms / 1000).toFixed(1).padStart(7)}s  ${rel}`);
  rows.push(`| ${state} | ${(ms / 1000).toFixed(1)} s | \`${rel.replace(/^packages\/d3gl\/src\//, "")}\` |`);
}
const totalS = results.reduce((sum, r) => sum + r.ms, 0) / 1000;
console.log(`  total ${totalS.toFixed(1)}s over ${results.length} file(s)`);
// On GitHub Actions, the same table on the job's summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
  const heading = `### Browser perf tier${shardArg ? `: ${shardArg}` : ""} (${totalS.toFixed(0)} s, ${results.length} files)`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [heading, "", "| result | time | file |", "|---|---|---|", ...rows, ""].join("\n") + "\n");
}
process.exit(failed ? 1 : 0);
