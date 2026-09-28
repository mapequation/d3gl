import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import { computeLODGeometry, computeLODPositions, type LODTree } from "../lod.js";
import { networkLayersFromCache, noLodStyleCache, type ResolvedNetworkStyle } from "../glyphs.js";
import { positionTransition, type PositionTransition } from "../transition.js";
import { PerformanceObserver } from "node:perf_hooks";

/**
 * Per-frame regression guard for position transitions (#328, AGENTS.md lifecycle §5). A transition is
 * a draw loop: every animation frame writes every node's position, then the engine repaints
 * positions-only. It must cost no more than the frame it stands in for — a **streamed layout frame**
 * (the worker posts positions, `scheduleLayoutRepaint` repaints) — and allocate nothing of its own.
 *
 * Both frames, as the engine runs them (the shared re-emit/upload tail is the browser guard's —
 * `network-transition-perf.browser.test.ts` drives the whole engine frame and counts GPU uploads):
 *   - **reductions ON** (a module-tree LOD): streamed = the transport's position copy + the full LOD
 *     geometry pass (`computeLODGeometry`: positions **and** style, incl. the colour aggregation);
 *     transition = the interpolation + the positions-only pass (`computeLODPositions`, as the drag path).
 *   - **reductions OFF** (every node drawn): streamed = the copy + the full-graph emit
 *     (`networkLayersFromCache`, the no-LOD rebuild's CPU work); transition = the interpolation + the
 *     same emit.
 * The transition is driven through the real {@link positionTransition} frame loop (a hand-cranked
 * frame queue, so each frame is timed alone).
 *
 * Signatures asserted (deterministic first):
 *   1. a transition frame never runs the style pass — the tree's radius/weight/border/colour arrays
 *      are byte-identical after the sweep (ON);
 *   2. it moves every frame, and lands exactly on the target;
 *   3. it allocates nothing beyond the streamed frame (OFF: both pay the emit's per-frame endpoint
 *      arrays; ON: nothing at all) — with `--expose-gc`;
 *   4. its median frame stays within the streamed frame's: under half of it with LOD on (no style
 *      pass), under 1.5× + 1 ms with LOD off (the interpolation vs a copy, under the same emit).
 * Wall-clock ceilings assert under `PERF_ASSERT` only (the CI tier).
 *
 * N is 100k in the normal suite; the ~1M leg is env-gated:
 *   BENCH_TRANSITION=1 NODE_OPTIONS=--expose-gc npx vitest run \
 *     packages/d3gl/src/network/__tests__/transition-perf.test.ts
 * Appends to /tmp/transition-perf.txt (BENCH_TRANSITION_LABEL).
 */
const BENCH = !!process.env.BENCH_TRANSITION;
const BENCH_N = Number(process.env.BENCH_TRANSITION_NODES) || 1_000_000;
// Calibration at N=1M on an M-series laptop (median of 12, --expose-gc): streamed ON 218 ms vs
// transition ON 19.6 ms; OFF streamed 6.9 ms vs transition 8.4 ms (the interpolation 2.1 ms vs a
// 0.2 ms copy, under a 6.7 ms emit). At 100k: ON 22.3 vs 2.0 ms, OFF 0.68 vs 0.82 ms. The ceilings
// are ~8-10× the transition's medians, so an O(N)-per-frame style pass (ON) trips them.
const ASSERT = !!process.env.PERF_ASSERT;
const ON_FRAME_MS = Number(process.env.PERF_TRANSITION_ON_MS) || 150;
const OFF_LERP_MS = Number(process.env.PERF_TRANSITION_OFF_MS) || 20;
/** Per-frame typed-array growth that still counts as "allocation-free" (KB). */
const ALLOC_KB_PER_FRAME = Number(process.env.PERF_TRANSITION_ALLOC_KB) || 64;
const FRAMES = 12;

/** A 3-level module hierarchy (top × sub × leaf ≈ ∛N each) over a chain graph, with two unrelated
 *  position sets to ease between. */
function fixture(n: number): { graph: NetworkGraph; tree: LODTree; a: Float32Array; b: Float32Array } {
  const side = Math.max(2, Math.round(Math.cbrt(n)));
  const records: ModuleNode[] = new Array<ModuleNode>(n);
  for (let i = 0; i < n; i++) {
    records[i] = { id: i, path: [Math.floor(i / (side * side)) + 1, (Math.floor(i / side) % side) + 1, (i % side) + 1] };
  }
  const source = new Uint32Array(n - 1);
  const target = new Uint32Array(n - 1);
  for (let i = 1; i < n; i++) {
    source[i - 1] = i;
    target[i - 1] = i - 1;
  }
  const graph = buildGraph({ nodeCount: n, source, target });
  const tree = buildModuleLODTree(n, records, graph);
  const a = new Float32Array(2 * n);
  const b = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++) {
    a[i] = (i * 7919) % 5000;
    b[i] = (i * 104729) % 5000;
  }
  return { graph, tree, a, b };
}

/** The resolved style a plain `style({})` gives (the glyphs.test.ts shape): lines, world size. */
function plainStyle(n: number): ResolvedNetworkStyle {
  return {
    nodeRadii: new Float32Array(n).fill(4),
    nodeRadiusAggregate: null,
    importance: new Float32Array(n).fill(1),
    nodeFill: "#000000",
    linkWidth: 1,
    linkWidthOf: () => 1,
    linkStroke: "#999999",
    linkColorOf: () => [153, 153, 153, 255],
    linkStrokeOf: () => "#999999",
    linkStyle: "line",
    arrowSize: 3,
    directed: false,
    sizeMode: "world",
    flowBorder: null,
    constBorder: null,
    linkBend: 0,
  };
}

/** Deterministic per-leaf RGBA — turns on the colour aggregation the streamed frame's style pass runs. */
function leafColors(n: number): Uint8Array {
  const c = new Uint8Array(4 * n);
  for (let i = 0; i < 4 * n; i++) c[i] = (i * 37) & 255;
  return c;
}

/** A hand-cranked transition from `from` to `to` over `frames` frames; `step()` runs one frame. */
function crankedTransition(positions: Float32Array, to: Float32Array, frames: number, onFrame: () => void): { t: PositionTransition; step(): void } {
  let time = 0;
  let pending: (() => void) | null = null;
  const t = positionTransition(positions, {
    duration: (frames + 1) * 16,
    onFrame,
    now: () => time,
    requestFrame: (cb) => {
      pending = cb;
      return 1;
    },
    cancelFrame: () => {
      pending = null;
    },
  });
  t.to(to);
  return {
    t,
    step() {
      time += 16;
      const cb = pending;
      pending = null;
      cb?.();
    },
  };
}

function median(ts: number[]): number {
  const s = [...ts].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
}

interface Leg {
  streamed: number;
  transition: number;
  streamedKB: number;
  transitionKB: number;
  moved: boolean;
  landed: boolean;
}

/** Frames whose allocation {@link frameAllocKB} samples. */
const ALLOC_FRAMES = 6;

/**
 * Median typed-array bytes (KB) one frame allocates. A full GC runs before EACH sampled frame, so the
 * previous frames' garbage is gone and cannot be collected mid-measurement: a single delta across a
 * loop of frames under-counts whenever V8 collects part-way through (seen in CI: the streamed baseline
 * measured 2115.9 KB/frame on one runner, 2441.4 on another, for the same commit — #340). Without
 * `--expose-gc` the numbers are rough and the caller doesn't assert on them.
 */
function frameAllocKB(gc: (() => void) | undefined, frame: (i: number) => void): number {
  const kb: number[] = [];
  for (let i = 0; i < ALLOC_FRAMES; i++) {
    gc?.();
    const m0 = process.memoryUsage().arrayBuffers;
    frame(i);
    kb.push((process.memoryUsage().arrayBuffers - m0) / 1024);
  }
  return median(kb);
}

/**
 * Time `FRAMES` streamed frames (copy + `streamedRepaint`) and `FRAMES` transition frames
 * (interpolation + `transitionRepaint`) at `n`, after a warm-up of each.
 */
const MARKS: { name: string; t: number }[] = [];
let LEG = "";
const mark = (n: string): void => { MARKS.push({ name: LEG + ":" + n, t: performance.now() }); };
function runLeg(graph: NetworkGraph, a: Float32Array, b: Float32Array, streamedRepaint: () => void, transitionRepaint: () => void, probes = true): Leg {
  const gc = (globalThis as { gc?: () => void }).gc;
  const pos = graph.positions;
  // Streamed: the transport copies each message's positions, then the coalesced repaint runs.
  const streamedFrame = (i: number): void => {
    pos.set(i % 2 ? a : b);
    streamedRepaint();
  };
  for (let i = 0; i < 4; i++) streamedFrame(i);
  mark("timed-s");
  const st: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const t0 = performance.now();
    streamedFrame(i);
    st.push(performance.now() - t0);
  }

  // Transition: warm the loop up on a short one, then time every frame of a real one a → b.
  pos.set(b);
  const warm = crankedTransition(pos, a, 4, transitionRepaint);
  for (let i = 0; i < 5; i++) warm.step();
  pos.set(a);
  const run = crankedTransition(pos, b, FRAMES, transitionRepaint);
  mark("timed-t");
  const tt: number[] = [];
  let moved = true;
  let prev = pos[0]!;
  for (let i = 0; i < FRAMES; i++) {
    const t0 = performance.now();
    run.step();
    tt.push(performance.now() - t0);
    if (pos[0] === prev && a[0] !== b[0]) moved = false;
    prev = pos[0]!;
  }
  mark("after");
  run.step(); // the last frame: exactly on the target
  let landed = !run.t.running;
  for (let i = 0; i < pos.length && landed; i++) if (pos[i] !== b[i]) landed = false;

  // Allocation, sampled only AFTER both timed loops: each sample forces a full GC, after which V8
  // shrinks the heap, so a timed loop run after the probes pays extra collections for the same
  // allocation (seen in CI: the LOD-off transition frame timed 2.6 → 6.3 ms, #340). The transition
  // probe is its own transition, so the timed one above ran start to end.
  if (!probes) return { streamed: median(st), transition: median(tt), streamedKB: 0, transitionKB: 0, moved, landed };
  const streamedKB = frameAllocKB(gc, (i) => streamedFrame(i));
  pos.set(a);
  const probe = crankedTransition(pos, b, ALLOC_FRAMES + 2, transitionRepaint);
  const transitionKB = frameAllocKB(gc, () => probe.step());
  return { streamed: median(st), transition: median(tt), streamedKB, transitionKB, moved, landed };
}


function runInterleaved(graph: NetworkGraph, a: Float32Array, b: Float32Array, streamedRepaint: () => void, transitionRepaint: () => void): Leg {
  const pos = graph.positions;
  const streamedFrame = (i: number): void => { pos.set(i % 2 ? a : b); streamedRepaint(); };
  for (let i = 0; i < 4; i++) streamedFrame(i);
  pos.set(b);
  const warm = crankedTransition(pos, a, 4, transitionRepaint);
  for (let i = 0; i < 5; i++) warm.step();
  pos.set(a);
  const run = crankedTransition(pos, b, FRAMES, transitionRepaint);
  mark("timed-s");
  const st: number[] = [];
  const tt: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    let t0 = performance.now(); streamedFrame(i); st.push(performance.now() - t0);
    t0 = performance.now(); run.step(); tt.push(performance.now() - t0);
  }
  mark("timed-t");
  run.step();
  return { streamed: median(st), transition: median(tt), streamedKB: 0, transitionKB: 0, moved: true, landed: true };
}

function prelude(n: number): void {
  const { graph, tree, a, b } = fixture(n);
  const radii = new Float32Array(n).fill(4);
  const colors = leafColors(n);
  graph.positions.set(a);
  computeLODGeometry(tree, graph, radii, graph.strength, undefined, colors);
  runLeg(graph, a, b, () => computeLODGeometry(tree, graph, radii, graph.strength, undefined, colors), () => computeLODPositions(tree, graph.positions), true);
  const style = plainStyle(n);
  const cache = noLodStyleCache(graph, style);
  runLeg(graph, a, b, () => void networkLayersFromCache(graph, style, cache), () => void networkLayersFromCache(graph, style, cache), true);
  runLeg(graph, a, b, () => {}, () => {}, true);
}

function diag(n: number): { line: string; gcs: { t: number; d: number; k: number }[] } {
  const gcs: { t: number; d: number; k: number }[] = [];
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) gcs.push({ t: e.startTime, d: e.duration, k: (e as unknown as { detail: { kind: number } }).detail.kind }); });
  obs.observe({ entryTypes: ["gc"] });
  const { graph, tree, a, b } = fixture(n);
  const radii = new Float32Array(n).fill(4);
  const colors = leafColors(n);
  graph.positions.set(a);
  computeLODGeometry(tree, graph, radii, graph.strength, undefined, colors);
  const style = plainStyle(n);
  const cache = noLodStyleCache(graph, style);
  const offRepaint = (): void => void networkLayersFromCache(graph, style, cache);
  const onS = (): void => computeLODGeometry(tree, graph, radii, graph.strength, undefined, colors);
  const onT = (): void => computeLODPositions(tree, graph.positions);
  const res: string[] = [];
  const r = (name: string, leg: Leg): void => { res.push(`${name} ${leg.streamed.toFixed(2)}/${leg.transition.toFixed(2)}=${(leg.transition / leg.streamed).toFixed(2)}`); };
  LEG = "offA"; r("offA(fresh)", runLeg(graph, a, b, offRepaint, offRepaint, false));
  LEG = "offAi"; r("offAi(fresh,interleaved)", runInterleaved(graph, a, b, offRepaint, offRepaint));
  LEG = "onP"; r("onProbed", runLeg(graph, a, b, onS, onT, true));
  LEG = "offC"; r("offC(asTheGuard)", runLeg(graph, a, b, offRepaint, offRepaint, true));
  LEG = "offCi"; r("offCi(interleaved)", runInterleaved(graph, a, b, offRepaint, offRepaint));
  LEG = "offD"; r("offD(seq again)", runLeg(graph, a, b, offRepaint, offRepaint, true));
  LEG = "offDi"; r("offDi(interleaved again)", runInterleaved(graph, a, b, offRepaint, offRepaint));
  return { line: res.join("  "), gcs };
}

describe("zz transition diag", () => {
  (process.env.BENCH_TRANSITION_DIAG ? it : it.skip)("diag", async () => {
    const n = Number(process.env.BENCH_TRANSITION_DIAG_N) || 500_000;
    prelude(100_000); // the guard file runs its 100k test first in the same process
    const { line, gcs } = diag(n);
    await new Promise((res) => setTimeout(res, 300));
    const marks = MARKS;
    const ph: string[] = [];
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i]!; const e = marks[i + 1]?.t ?? Infinity;
      const g = gcs.filter((x) => x.t >= m.t && x.t < e);
      const c = (k: number): string => `${g.filter((x) => x.k === k).length}/${g.filter((x) => x.k === k).reduce((p, x) => p + x.d, 0).toFixed(1)}`;
      if (m.name.endsWith("timed-s") || m.name.endsWith("timed-t")) ph.push(`${m.name} minor ${c(1)} major ${c(4)} incr ${c(8)}`);
    }
    console.log(`DIAG N=${n} ${line}\n${ph.join("\n")}`);
    if (process.env.DIAG_OUT) appendFileSync(process.env.DIAG_OUT, `DIAG N=${n} ${line}\n${ph.join("\n")}\n`);
  }, 600_000);
});
