#!/usr/bin/env node
// Wall-clock watchdog around the browser (Playwright/Chromium) test run.
//
// Why this exists: the *.browser.test.ts suites have repeatedly hung — not
// inside a test body (Vitest's testTimeout/hookTimeout already bound those),
// but in the parts Vitest can't time out: the Vite dependency optimizer, the
// Playwright browser launch, the browser<->server connection, or a Chromium
// process that refuses to exit after the tests have already passed. A leaked
// WebGL context (luma's device.destroy() never calls WEBGL_lose_context) makes
// the post-run teardown the most common stall point.
//
// This wrapper guarantees the command can never block indefinitely: if the run
// exceeds the wall-clock budget it kills the whole process group (Vitest + the
// browser it spawned) and exits non-zero with an actionable message, turning an
// infinite hang into a fast, diagnosable failure.
//
// Budget can be overridden:
//   D3GL_BROWSER_TEST_TIMEOUT=300000 pnpm test:browser   (env, milliseconds)
//   pnpm test:browser --watchdog-timeout=300000          (flag, milliseconds)
// Any other args are forwarded to vitest unchanged.

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 180_000; // healthy full run is ~25s; this is generous headroom.
const KILL_GRACE_MS = 5_000; // SIGTERM -> SIGKILL escalation window.

const forwarded = [];
let timeoutMs = Number(process.env.D3GL_BROWSER_TEST_TIMEOUT) || DEFAULT_TIMEOUT_MS;
for (const arg of process.argv.slice(2)) {
  const m = /^--watchdog-timeout=(\d+)$/.exec(arg);
  if (m) timeoutMs = Number(m[1]);
  else forwarded.push(arg);
}

const vitestArgs = ["vitest", "run", "--config", "vitest.config.ts", ...forwarded];

// detached:true puts the child in its own process group so we can signal the
// whole tree (Chromium is a grandchild) with a single negative-PID kill.
const child = spawn("pnpm", ["exec", ...vitestArgs], {
  stdio: "inherit",
  detached: true,
});

let timedOut = false;

const killTree = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone — fall back to the direct child.
    try {
      child.kill(signal);
    } catch {
      /* nothing left to kill */
    }
  }
};

const watchdog = setTimeout(() => {
  timedOut = true;
  const seconds = Math.round(timeoutMs / 1000);
  process.stderr.write(
    `\n*** browser tests exceeded the ${seconds}s watchdog budget — killing the run.\n` +
      `    This is the recurring hang: the suite stalled outside any test body\n` +
      `    (browser launch / vite optimizer / post-run teardown of a leaked\n` +
      `    WebGL context). Re-run locally to inspect, or raise the budget with\n` +
      `    D3GL_BROWSER_TEST_TIMEOUT=<ms> if the machine is genuinely slow.\n`,
  );
  killTree("SIGTERM");
  // Escalate if the tree ignores SIGTERM (a wedged Chromium often does).
  setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS).unref();
}, timeoutMs);
watchdog.unref();

// Forward Ctrl-C / termination to the whole tree so no Chromium is orphaned.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => killTree(sig));
}

child.on("exit", (code, signal) => {
  clearTimeout(watchdog);
  if (timedOut) process.exit(124); // conventional timeout exit code.
  if (signal) {
    process.stderr.write(`\nbrowser tests terminated by signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  clearTimeout(watchdog);
  process.stderr.write(`\nfailed to launch browser tests: ${err.message}\n`);
  process.exit(1);
});
