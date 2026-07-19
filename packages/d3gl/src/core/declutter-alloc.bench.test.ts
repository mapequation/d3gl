import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { Session } from "node:inspector";
import { declutterScreen, declutterScratch } from "./declutter.js";

const OUT = "/tmp/declutter-alloc.txt";

// #233: `declutterScreen` must run with O(1) transient heap allocation per call, independent of
// `count`. The pre-#233 engine read the per-glyph radius through a `radAt` closure — every call
// returned a fresh non-Smi double across a non-inlined call boundary, which V8 boxes as a
// HeapNumber: O(count + collision tests) transient garbage (~41 MB per call at count = 300k,
// measured with the sampling heap profiler and attributed to `radAt`), churned by every per-frame
// caller (network LOD frontier declutter, geo/map declutter, plot points lane). A shared loop with
// a `radii ? radii[i] : uniformR` ternary still boxed one double per read (mixed-representation
// phi), hence the two specialized loops in the engine.
//
// Two guards in this file:
//   1. byte-identity (normal suite): the split-loop engine is element-identical — kept flags AND
//      winners — to a verbatim copy of the pre-#233 closure-based engine, across the caller
//      shapes (per-glyph radius + order + ignore + winners; uniform radius).
//   2. allocation guard (env-gated, #220 perf tier): the V8 sampling heap profiler (counting
//      objects collected by GC, not just live ones) must attribute ~0 bytes to `declutterScreen`
//      across isolated calls at count = BENCH_DECLUTTER_ALLOC_N (default 300k; CI sets PERF_N).
//      Attribution is the deterministic signature: it is independent of nursery size, which makes
//      gc-bracketed heapUsed deltas under-report by whatever the scavenger already collected
//      (the delta is still reported for context). Report-only locally; PERF_ASSERT=1 (the perf
//      tier) turns the ceiling into an assertion.
//   Run it deliberately:
//     BENCH_DECLUTTER_ALLOC=1 PERF_ASSERT=1 NODE_OPTIONS=--expose-gc npx vitest run \
//       packages/d3gl/src/core/declutter-alloc.bench.test.ts --no-file-parallelism
//
// NOTE: every declutterScreen call in this file uses the production element types — Float64Array
// positions/radii or a number radius (what lod.ts, base-engine.ts, and points-lane.ts pass).
// Feeding another typed-array map (e.g. a Float32Array radius) into the same IC sites makes V8
// fall back to boxing loads in THIS process, so a mixed-type case here would poison the bench
// into measuring a shape no production caller has.
const RUN = !!process.env.BENCH_DECLUTTER_ALLOC;
const BENCH_N = Number(process.env.BENCH_DECLUTTER_ALLOC_N) || 300_000;
const ASSERT = !!process.env.PERF_ASSERT;
// Allocation-free is O(1) per call regardless of count; the pre-#233 engine allocates ~41 MB/call
// at 300k, so a fixed 1 MB ceiling over the whole measured run separates by ~3 orders of magnitude.
const MAX_ENGINE_BYTES = 1 << 20;

const W = 1280;
const H = 800;

/** Verbatim copy of the pre-#233 `declutterScreen` (closure-based `radAt`) — the byte-identity
 *  reference the split-loop engine must reproduce exactly (same kept set, same winners). */
function declutterScreenRef(
  count: number,
  sx: ArrayLike<number>,
  sy: ArrayLike<number>,
  radius: ArrayLike<number> | number,
  order: ArrayLike<number> | undefined,
  width: number,
  height: number,
  spacing: number,
  out: Uint8Array,
  scratch = declutterScratch(),
  ignore?: (i: number, j: number) => boolean,
  winners?: Int32Array,
): Uint8Array {
  const radAt = typeof radius === "number" ? (_i: number) => radius : (i: number) => radius[i]!;
  let maxR = 1;
  for (let i = 0; i < count; i++) {
    const r = radAt(i);
    if (r > maxR) maxR = r;
  }
  const cell = Math.max(2 * maxR * spacing, 1);
  const cols = Math.floor(width / cell) + 3;
  const rows = Math.floor(height / cell) + 3;
  const nCells = cols * rows;
  if (scratch.head.length < nCells) scratch.head = new Int32Array(nCells);
  if (scratch.next.length < count) scratch.next = new Int32Array(count);
  const head = scratch.head;
  const next = scratch.next;
  head.fill(-1, 0, nCells);
  for (let oi = 0; oi < count; oi++) {
    const i = order ? order[oi]! : oi;
    const x = sx[i]!;
    const y = sy[i]!;
    const r = radAt(i);
    if (x < 0 || y < 0 || x > width || y > height) {
      out[i] = 1;
      if (winners) winners[i] = i;
      continue;
    }
    let cx = Math.floor(x / cell) + 1;
    let cy = Math.floor(y / cell) + 1;
    cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
    cy = cy < 0 ? 0 : cy >= rows ? rows - 1 : cy;
    let occluded = false;
    for (let gx = cx - 1; gx <= cx + 1 && !occluded; gx++) {
      if (gx < 0 || gx >= cols) continue;
      for (let gy = cy - 1; gy <= cy + 1 && !occluded; gy++) {
        if (gy < 0 || gy >= rows) continue;
        for (let p = head[gy * cols + gx]!; p !== -1; p = next[p]!) {
          const dx = sx[p]! - x;
          const dy = sy[p]! - y;
          const thresh = spacing * (r + radAt(p));
          if (dx * dx + dy * dy < thresh * thresh) {
            if (ignore && ignore(i, p)) continue;
            occluded = true;
            if (winners) winners[i] = p;
            break;
          }
        }
      }
    }
    if (!occluded) {
      out[i] = 1;
      if (winners) winners[i] = i;
      const c = cy * cols + cx;
      next[i] = head[c]!;
      head[c] = i;
    } else {
      out[i] = 0;
    }
  }
  return out;
}

/** Deterministic fixture: screen-pixel centres (a band beyond the viewport hits the off-screen
 *  keep branch), fractional (non-Smi) per-glyph radii, and an importance-order permutation. */
function fixture(n: number): { sx: Float64Array; sy: Float64Array; rad: Float64Array; order: Uint32Array } {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const rad = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sx[i] = rng() * (W + 100) - 50;
    sy[i] = rng() * (H + 100) - 50;
    rad[i] = 1.5 + rng() * 5; // non-integer doubles — the boxing case
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  return { sx, sy, rad, order };
}

function expectSameBytes(actual: ArrayLike<number>, reference: ArrayLike<number>, what: string): void {
  expect(actual.length, `${what} length`).toBe(reference.length);
  let mismatch = -1;
  for (let i = 0; i < reference.length; i++) {
    if (actual[i] !== reference[i]) { mismatch = i; break; }
  }
  expect(mismatch, `${what} first mismatching index`).toBe(-1);
}

describe("#233 declutterScreen byte-identity with the closure-based reference", () => {
  it("kept flags and winners match across the caller shapes", () => {
    const N = 30_000;
    const { sx, sy, rad, order } = fixture(N);
    const ignore = (i: number, j: number): boolean => (i * 31 + j) % 41 === 0;
    const cases: {
      name: string;
      radius: ArrayLike<number> | number;
      order?: Uint32Array;
      ignore?: (i: number, j: number) => boolean;
      winners: boolean;
    }[] = [
      // The network LOD frontier shape (per-glyph radius, importance order, cross-fade ignore).
      { name: "per-glyph radius + order + ignore + winners", radius: rad, order, ignore, winners: true },
      { name: "per-glyph radius, index order", radius: rad, winners: true },
      // The geo/map and plot points-lane shape (uniform half-spacing radius).
      { name: "uniform radius", radius: 3.25, winners: true },
      { name: "uniform radius + order + ignore, no winners", radius: 3.25, order, ignore, winners: false },
    ];
    for (const c of cases) {
      const outA = new Uint8Array(N);
      const outR = new Uint8Array(N);
      const winA = c.winners ? new Int32Array(N).fill(-7) : undefined;
      const winR = c.winners ? new Int32Array(N).fill(-7) : undefined;
      declutterScreen(N, sx, sy, c.radius, c.order, W, H, 1, outA, declutterScratch(), c.ignore, winA);
      declutterScreenRef(N, sx, sy, c.radius, c.order, W, H, 1, outR, declutterScratch(), c.ignore, winR);
      expectSameBytes(outA, outR, `${c.name}: kept`);
      if (winA && winR) expectSameBytes(winA, winR, `${c.name}: winners`);
    }
  });
});

/** One node of the V8 sampling heap profile (structural subset of
 *  inspector's HeapProfiler.SamplingHeapProfileNode). */
interface SamplingNode {
  callFrame: { functionName: string };
  selfSize: number;
  children: SamplingNode[];
}

/** Sum the sampled allocation bytes attributed to `name` and everything called from it. */
function bytesAllocatedIn(node: SamplingNode, name: string, inside: boolean): number {
  const here = inside || node.callFrame.functionName === name;
  let sum = here ? node.selfSize : 0;
  for (const c of node.children) sum += bytesAllocatedIn(c, name, here);
  return sum;
}

/** Run `frames` calls under the sampling heap profiler (counting GC-collected objects too) and
 *  return the bytes attributed to `fnName`, plus the max gc-bracketed heapUsed delta for context. */
async function sampleAllocations(
  run: () => void,
  frames: number,
  fnName: string,
): Promise<{ engineBytes: number; maxDelta: number }> {
  const session = new Session();
  session.connect();
  const start = new Promise<void>((resolve, reject) => {
    session.post(
      "HeapProfiler.startSampling",
      { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true },
      (err) => (err ? reject(err) : resolve()),
    );
  });
  await start;
  const h0 = process.memoryUsage().heapUsed;
  let maxDelta = 0;
  for (let i = 0; i < frames; i++) {
    run();
    const d = process.memoryUsage().heapUsed - h0;
    if (d > maxDelta) maxDelta = d;
  }
  const head = await new Promise<SamplingNode>((resolve, reject) => {
    session.post("HeapProfiler.stopSampling", (err, r) => (err ? reject(err) : resolve(r.profile.head)));
  });
  session.disconnect();
  return { engineBytes: bytesAllocatedIn(head, fnName, false), maxDelta };
}

describe.skipIf(!RUN)("#233 declutterScreen transient allocation", () => {
  it(`isolated calls at count = ${BENCH_N.toLocaleString()} allocate ~0 transient heap`, async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (ASSERT && !gc) {
      throw new Error("PERF_ASSERT needs real heap deltas — run with NODE_OPTIONS=--expose-gc");
    }
    const N = BENCH_N;
    const { sx, sy, rad, order } = fixture(N);
    const winners = new Int32Array(N);
    // The two per-frame caller shapes: per-glyph radius + order + winners (network LOD frontier)
    // and uniform radius, index order (geo/map declutter, plot points lane).
    const cases: { name: string; radius: ArrayLike<number> | number; order?: Uint32Array }[] = [
      { name: "per-glyph radius + order + winners", radius: rad, order },
      { name: "uniform radius", radius: 3.25 },
    ];
    const WARMUP = 8;
    const FRAMES = 16;
    const failures: string[] = [];
    for (const c of cases) {
      const out = new Uint8Array(N);
      const scratch = declutterScratch(); // warmed below — grid growth happens before the bracket
      const run = (): Uint8Array => declutterScreen(N, sx, sy, c.radius, c.order, W, H, 1, out, scratch, undefined, winners);
      for (let i = 0; i < WARMUP; i++) run();
      gc?.();
      const { engineBytes, maxDelta } = await sampleAllocations(run, FRAMES, "declutterScreen");
      const line =
        `${c.name.padEnd(38)} count=${N.toLocaleString()}  engineAlloc=${(engineBytes / 1024 / 1024).toFixed(2)}MB/${FRAMES} calls ` +
        `(${(engineBytes / FRAMES / N).toFixed(1)} B/glyph/call)  heapUsedMaxDelta=${(maxDelta / 1024 / 1024).toFixed(2)}MB` +
        `${gc ? "" : " (no --expose-gc; delta rough)"}\n`;
      console.log(line);
      appendFileSync(OUT, `[${process.env.BENCH_DECLUTTER_ALLOC_LABEL ?? "run"}] ${line}`);
      if (engineBytes >= MAX_ENGINE_BYTES) {
        failures.push(`${c.name}: ${engineBytes} bytes attributed to declutterScreen (ceiling ${MAX_ENGINE_BYTES})`);
      }
    }
    if (ASSERT) expect(failures, failures.join("; ")).toEqual([]);
  }, 120_000);
});
