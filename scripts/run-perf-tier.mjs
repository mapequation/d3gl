#!/usr/bin/env node
// At-scale perf-guard tier (#220): run every env-gated node bench with its gates ON,
// at a reduced-but-real N, with assertions enabled — so the ~1M-class per-frame guards
// that are skipped in the normal suite actually execute (and fail) in CI.
//
// DISCOVERY IS PATTERN-DRIVEN, not a hard-coded list: any node test file under
// packages/*/src that reads `process.env.BENCH_<FLAG>` is part of the tier. A merged
// PR that adds a new env-gated bench is picked up automatically on the next run.
// Flag conventions (all existing benches follow them):
//   BENCH_<NAME>          gate        → set to "1"
//   BENCH_<NAME>_N(ODES)  input scale → set to $PERF_N (default 500000)
//   BENCH_<NAME>_LABEL    report label→ set to "ci"
// A flag already present in the environment is left untouched, so the CI workflow (or a
// local run) can pin any bench's N individually (e.g. BENCH_GEO_SWEEP_N=200000).
//
// Each file runs in its own vitest process (isolation: one bench's heap/JIT state can't
// skew the next; --expose-gc reaches every worker) under --no-file-parallelism, with
//   PERF_ASSERT=1  — benches that support it turn their report-only measurements into
//                    assertions (generous ceilings; see each bench file). Report-only
//                    benches still execute under the per-file wall-clock budget below.
//   NODE_OPTIONS=--expose-gc  — memory benches need real heap deltas.
// The runner enforces a hard per-file wall-clock budget ($PERF_FILE_BUDGET_MS, default
// 300000 = 5 min): a file that exceeds it is killed and FAILS the tier. That budget is
// the pattern-level guard for report-only benches — an order-of-magnitude regression
// (or a hang) goes red even before the bench gains its own assertions.
//
// Usage:
//   node scripts/run-perf-tier.mjs             # the CI invocation
//   PERF_N=1000000 node scripts/run-perf-tier.mjs   # full-scale local run
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PERF_N = process.env.PERF_N ?? "500000";
const FILE_BUDGET_MS = Number(process.env.PERF_FILE_BUDGET_MS) || 300_000;

/** Recursively collect node test files (browser tests run in their own tier). */
function testFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (e.name.endsWith(".test.ts") && !e.name.endsWith(".browser.test.ts")) out.push(p);
  }
  return out;
}

/** All packages/<pkg>/src roots that exist. */
function srcRoots() {
  const pkgs = join(root, "packages");
  return readdirSync(pkgs)
    .map((p) => join(pkgs, p, "src"))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

// ---- discover: file → set of BENCH_* flags it reads --------------------------------
const FLAG_RE = /process\.env\.(BENCH_[A-Z0-9_]+)/g;
const benches = [];
for (const rootDir of srcRoots()) {
  for (const file of testFiles(rootDir)) {
    const src = readFileSync(file, "utf8");
    const flags = new Set();
    for (const m of src.matchAll(FLAG_RE)) flags.add(m[1]);
    if (flags.size > 0) benches.push({ file, flags: [...flags].sort() });
  }
}
benches.sort((a, b) => a.file.localeCompare(b.file));

if (benches.length === 0) {
  console.error("perf tier: no env-gated benches found (expected process.env.BENCH_* readers) — discovery is broken");
  process.exit(1);
}

// ---- assemble the environment: every discovered flag ON, scales reduced ------------
const env = { ...process.env, PERF_ASSERT: process.env.PERF_ASSERT ?? "1" };
env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--expose-gc"].filter(Boolean).join(" ");
for (const { flags } of benches) {
  for (const flag of flags) {
    if (process.env[flag] != null) continue; // explicit pin wins
    if (flag.endsWith("_LABEL")) env[flag] = "ci";
    else if (flag.endsWith("_NODES") || flag.endsWith("_N")) env[flag] = PERF_N;
    else env[flag] = "1";
  }
}

console.log(`perf tier: ${benches.length} bench file(s), PERF_N=${PERF_N}, budget ${FILE_BUDGET_MS}ms/file`);
for (const { file, flags } of benches) console.log(`  ${relative(root, file)}  [${flags.join(", ")}]`);

// ---- run each file in its own vitest process, timed, hard-killed at the budget -----
const results = [];
for (const { file } of benches) {
  const rel = relative(root, file);
  console.log(`\n=== ${rel} ===`);
  const t0 = Date.now();
  // Spawn vitest directly under node (not via a pnpm shim) so the budget's SIGKILL
  // reaches the vitest process itself.
  const r = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", rel, "--no-file-parallelism"], {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: FILE_BUDGET_MS,
    killSignal: "SIGKILL",
  });
  const ms = Date.now() - t0;
  const timedOut = r.error?.code === "ETIMEDOUT";
  const ok = !timedOut && r.status === 0;
  results.push({ rel, ms, ok, timedOut });
}

// ---- summary ------------------------------------------------------------------------
console.log("\nperf tier summary");
let failed = false;
for (const { rel, ms, ok, timedOut } of results) {
  const state = ok ? "PASS" : timedOut ? `FAIL (killed at ${FILE_BUDGET_MS}ms budget)` : "FAIL";
  if (!ok) failed = true;
  console.log(`  ${state.padEnd(6)} ${(ms / 1000).toFixed(1).padStart(7)}s  ${rel}`);
}
process.exit(failed ? 1 : 0);
