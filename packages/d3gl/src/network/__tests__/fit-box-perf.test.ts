import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { layoutBox, type FitBox } from "../fit.js";

/**
 * Per-frame regression guard for the streaming fit's box (#327, AGENTS.md lifecycle §5).
 *
 * While a `layout({ fit: true })` streams, each streamed layout frame runs {@link layoutBox} over every
 * leaf position before the repaint: O(nodes) per streamed frame, the same with LOD on or off (it reads the
 * leaves, never the LOD tree), and only while the fit is on — the fit is not reachable from `setTransform`,
 * so a zoom frame never pays it, and a released fit stops paying it. It rides on a frame that already does
 * O(nodes) work (the transport's position copy, the LOD geometry pass or the full-detail re-emit), so the
 * guard pins it to a small constant factor of a pass over the positions:
 *   1. allocation-free — no typed-array growth per call (a fixed 2 KB histogram is reused);
 *   2. exact on every input regime: a clean disc gets its exact bounding box — stored in radial order (the
 *      rim last: the certifying pass cannot stop early, two full passes) and shuffled (the usual storage
 *      order: one pass plus a short certify) — and a disc with 64 flung-out stragglers gets the bulk's
 *      (four passes — the worst case);
 *   3. a wall-clock ceiling per call (under PERF_ASSERT, the CI tier).
 *
 * N is 200k in the normal suite; the ~1M leg is env-gated:
 *   BENCH_FIT_BOX=1 NODE_OPTIONS=--expose-gc npx vitest run packages/d3gl/src/network/__tests__/fit-box-perf.test.ts
 * Appends to /tmp/fit-box-perf.txt (BENCH_FIT_BOX_LABEL).
 */
const BENCH = !!process.env.BENCH_FIT_BOX;
const BENCH_N = Number(process.env.BENCH_FIT_BOX_NODES) || 1_000_000;
// Calibration at N=1M on an M-series laptop (median of 15, --expose-gc): clean radial 3.1 ms, clean
// shuffled 1.2 ms, stragglers 10.9 ms; at 200k: 0.63 / 0.25 / 2.2 ms; 0.0 KB allocated per call. The
// ceilings are ~10× the medians, so a second copy of the positions or a per-call sort trips them.
const ASSERT = !!process.env.PERF_ASSERT;
/** Per-call ceiling per million leaves (ms), clean and straggler regimes. */
const CLEAN_MS_PER_M = Number(process.env.PERF_FIT_BOX_CLEAN_MS) || 30;
const STRAGGLER_MS_PER_M = Number(process.env.PERF_FIT_BOX_STRAGGLER_MS) || 110;
/** Typed-array growth per call that still counts as allocation-free (KB). A per-call copy of the
 *  positions would move 8 MB at 1M leaves. */
const ALLOC_KB_PER_CALL = Number(process.env.PERF_FIT_BOX_ALLOC_KB) || 16;
const CALLS = 15;
const STRAGGLERS = 64;

/** `pos` with its leaves in a deterministic random storage order (Fisher-Yates, fixed seed). */
function shuffled(pos: Float32Array, n: number): Float32Array {
  const out = pos.slice();
  let s = 12345;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const x = out[2 * i] ?? 0;
    const y = out[2 * i + 1] ?? 0;
    out[2 * i] = out[2 * j] ?? 0;
    out[2 * i + 1] = out[2 * j + 1] ?? 0;
    out[2 * j] = x;
    out[2 * j + 1] = y;
  }
  return out;
}

/** A uniform disc of `n` leaves (a settled force layout) in radial order, optionally with its first
 *  `stragglers` flung far out. */
function disc(n: number, stragglers: number): Float32Array {
  const pos = new Float32Array(2 * n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = Math.sqrt(n) * 50;
  for (let i = 0; i < n; i++) {
    const d = r * Math.sqrt((i + 0.5) / n);
    pos[2 * i] = d * Math.cos(i * golden);
    pos[2 * i + 1] = d * Math.sin(i * golden);
  }
  for (let i = 0; i < stragglers; i++) {
    pos[2 * i] = 20 * r + i;
    pos[2 * i + 1] = -20 * r - i;
  }
  return pos;
}

function exactBox(pos: Float32Array, from: number, n: number): FitBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = from; i < n; i++) {
    const x = pos[2 * i] ?? 0;
    const y = pos[2 * i + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function median(ts: number[]): number {
  const s = [...ts].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

interface Leg {
  ms: number;
  allocKB: number;
  box: FitBox | null;
}

function runLeg(pos: Float32Array, n: number): Leg {
  const gc = (globalThis as { gc?: () => void }).gc;
  for (let i = 0; i < 3; i++) layoutBox(pos, n); // warm up (JIT)
  gc?.();
  const ab0 = process.memoryUsage().arrayBuffers;
  const ts: number[] = [];
  let box: FitBox | null = null;
  for (let i = 0; i < CALLS; i++) {
    const t0 = performance.now();
    box = layoutBox(pos, n);
    ts.push(performance.now() - t0);
  }
  const allocKB = (process.memoryUsage().arrayBuffers - ab0) / 1024 / CALLS;
  return { ms: median(ts), allocKB, box };
}

function relErr(box: FitBox | null, ref: FitBox): number {
  if (!box) return Infinity;
  const span = Math.max(ref[2] - ref[0], ref[3] - ref[1]);
  return Math.max(...box.map((v, i) => Math.abs(v - (ref[i] ?? 0)) / span));
}

function guard(n: number, label: string | undefined): void {
  const clean = disc(n, 0);
  const mixed = shuffled(clean, n);
  const flung = disc(n, STRAGGLERS);
  const c = runLeg(clean, n);
  const m = runLeg(mixed, n);
  const s = runLeg(flung, n);

  // 2. exact on every regime: the clean disc's exact box (either storage order), the flung disc's bulk.
  expect(relErr(c.box, exactBox(clean, 0, n))).toBeLessThan(1e-6);
  expect(relErr(m.box, exactBox(clean, 0, n))).toBeLessThan(1e-6);
  expect(relErr(s.box, exactBox(flung, STRAGGLERS, n))).toBeLessThan(0.01);
  // 1. allocation-free.
  for (const leg of [c, m, s]) expect(leg.allocKB).toBeLessThan(ALLOC_KB_PER_CALL);
  // 3. frame budget (the CI tier only — wall-clock is contention-sensitive).
  if (ASSERT) {
    expect(c.ms).toBeLessThan((CLEAN_MS_PER_M * n) / 1e6 + 1);
    expect(m.ms).toBeLessThan((CLEAN_MS_PER_M * n) / 1e6 + 1);
    expect(s.ms).toBeLessThan((STRAGGLER_MS_PER_M * n) / 1e6 + 1);
  }
  const line = `fit-box N=${n}${label ? ` [${label}]` : ""}: clean radial ${c.ms.toFixed(2)} ms, clean shuffled ${m.ms.toFixed(2)} ms, stragglers ${s.ms.toFixed(2)} ms (alloc ${Math.max(c.allocKB, m.allocKB, s.allocKB).toFixed(1)} KB/call)`;
  console.log(line);
  if (BENCH) appendFileSync("/tmp/fit-box-perf.txt", line + "\n");
}

describe("streaming fit box (#327): O(nodes) per streamed frame, allocation-free", () => {
  it("200k leaves: exact, allocation-free, within budget", () => {
    guard(200_000, undefined);
  });

  it.runIf(BENCH)(`${BENCH_N} leaves (BENCH_FIT_BOX)`, () => {
    guard(BENCH_N, process.env.BENCH_FIT_BOX_LABEL);
  });
});
