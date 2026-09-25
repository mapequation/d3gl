import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import { computeLODGeometry, computeLODPositions, type LODTree } from "../lod.js";
import { networkLayersFromCache, noLodStyleCache, type ResolvedNetworkStyle } from "../glyphs.js";
import { positionTransition, type PositionTransition } from "../transition.js";

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
function runLeg(graph: NetworkGraph, a: Float32Array, b: Float32Array, streamedRepaint: () => void, transitionRepaint: () => void): Leg {
  const gc = (globalThis as { gc?: () => void }).gc;
  const pos = graph.positions;
  // Streamed: the transport copies each message's positions, then the coalesced repaint runs.
  const streamedFrame = (i: number): void => {
    pos.set(i % 2 ? a : b);
    streamedRepaint();
  };
  for (let i = 0; i < 4; i++) streamedFrame(i);
  const st: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const t0 = performance.now();
    streamedFrame(i);
    st.push(performance.now() - t0);
  }
  const streamedKB = frameAllocKB(gc, (i) => streamedFrame(i));

  // Transition: warm the loop up on a short one, then time every frame of a real one a → b.
  pos.set(b);
  const warm = crankedTransition(pos, a, 4, transitionRepaint);
  for (let i = 0; i < 5; i++) warm.step();
  pos.set(a);
  // Allocation: its own transition, so the timed one below still runs start to end.
  const probe = crankedTransition(pos, b, ALLOC_FRAMES + 2, transitionRepaint);
  const transitionKB = frameAllocKB(gc, () => probe.step());
  pos.set(a);
  const run = crankedTransition(pos, b, FRAMES, transitionRepaint);
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
  run.step(); // the last frame: exactly on the target
  let landed = !run.t.running;
  for (let i = 0; i < pos.length && landed; i++) if (pos[i] !== b[i]) landed = false;
  return { streamed: median(st), transition: median(tt), streamedKB, transitionKB, moved, landed };
}

function guard(n: number, label: string): void {
  const { graph, tree, a, b } = fixture(n);
  const radii = new Float32Array(n).fill(4);
  const colors = leafColors(n);
  graph.positions.set(a);
  computeLODGeometry(tree, graph, radii, graph.strength, undefined, colors);
  const gc = (globalThis as { gc?: () => void }).gc;

  // Reductions ON: the module-tree LOD's geometry.
  const styleBefore = [tree.radius.slice(), tree.weight.slice(), tree.border.slice(), tree.color.slice()];
  const on = runLeg(
    graph, a, b,
    () => computeLODGeometry(tree, graph, radii, graph.strength, undefined, colors),
    () => computeLODPositions(tree, graph.positions),
  );
  // …the streamed frames re-ran the style pass (same values); what matters is that the transition's
  // frames never wrote it, so re-derive and compare after a transition-only sweep.
  computeLODGeometry(tree, graph, radii, graph.strength, undefined, colors);
  const styleRef = [tree.radius.slice(), tree.weight.slice(), tree.border.slice(), tree.color.slice()];
  tree.radius.fill(-1); // poison: a transition frame that runs the style pass would overwrite it
  const poisoned = crankedTransition(graph.positions, a, 3, () => computeLODPositions(tree, graph.positions));
  for (let i = 0; i < 4; i++) poisoned.step();
  const stylePassRan = tree.radius.some((v) => v !== -1);
  tree.radius.set(styleRef[0]!);

  // Reductions OFF: the full-graph emit, over a style cache built once (as the engine's).
  const style = plainStyle(n);
  const cache = noLodStyleCache(graph, style);
  const off = runLeg(graph, a, b, () => void networkLayersFromCache(graph, style, cache), () => void networkLayersFromCache(graph, style, cache));
  // The interpolation alone, for its own ceiling and its own allocation signature.
  const lerpOnly = runLeg(graph, a, b, () => {}, () => {});

  const line =
    `N=${n.toLocaleString()} tree=${tree.size.toLocaleString()}  ON streamed=${on.streamed.toFixed(2)}ms transition=${on.transition.toFixed(2)}ms  ` +
    `OFF streamed=${off.streamed.toFixed(2)}ms transition=${off.transition.toFixed(2)}ms (lerp ${lerpOnly.transition.toFixed(2)}ms vs copy ${lerpOnly.streamed.toFixed(2)}ms)  ` +
    `alloc KB/frame ON ${on.transitionKB.toFixed(1)}/${on.streamedKB.toFixed(1)} OFF ${off.transitionKB.toFixed(1)}/${off.streamedKB.toFixed(1)}${gc ? "" : " (no --expose-gc; rough)"}\n`;
  console.log(line);
  if (BENCH) appendFileSync("/tmp/transition-perf.txt", `[${process.env.BENCH_TRANSITION_LABEL ?? label}] ${line}`);

  // 1. no style pass per transition frame
  expect(stylePassRan, "a transition frame ran the LOD style pass").toBe(false);
  expect(styleBefore[1]!.length).toBe(tree.size); // non-vacuity: the tree carries style arrays
  // 2. it moves, and lands exactly
  for (const leg of [on, off, lerpOnly]) {
    expect(leg.moved, "a transition frame left the positions where they were").toBe(true);
    expect(leg.landed, "the transition did not land exactly on its target").toBe(true);
  }
  // 3. no allocation of its own (meaningful only with --expose-gc)
  if (gc) {
    expect(on.transitionKB, `ON: ${on.transitionKB.toFixed(1)} KB/frame allocated`).toBeLessThan(ALLOC_KB_PER_FRAME);
    expect(lerpOnly.transitionKB, `interpolation: ${lerpOnly.transitionKB.toFixed(1)} KB/frame allocated`).toBeLessThan(ALLOC_KB_PER_FRAME);
    expect(off.transitionKB, `OFF: ${off.transitionKB.toFixed(1)} KB/frame vs ${off.streamedKB.toFixed(1)} streamed`).toBeLessThan(off.streamedKB + ALLOC_KB_PER_FRAME);
  }
  // 4. within the streamed frame's budget, in both reduction states. ON it must stay well below: it
  //    skips the style pass (measured 0.09× at 1M and 100k) — a style pass back in the loop lands ≈1×.
  //    OFF the interpolation reads two buffers where the copy reads one, on top of the same emit
  //    (measured 1.2× at 100k and 1M) — an order-of-magnitude slip still trips 1.5× + 1 ms.
  expect(on.transition, `ON: transition ${on.transition.toFixed(2)}ms vs streamed ${on.streamed.toFixed(2)}ms`).toBeLessThan(on.streamed * 0.5);
  expect(off.transition, `OFF: transition ${off.transition.toFixed(2)}ms vs streamed ${off.streamed.toFixed(2)}ms`).toBeLessThan(off.streamed * 1.5 + 1);
  if (ASSERT) {
    expect(on.transition, `ON: ${on.transition.toFixed(1)}ms at N=${n}`).toBeLessThan(ON_FRAME_MS * (n / 1_000_000) + 5);
    expect(lerpOnly.transition, `interpolation: ${lerpOnly.transition.toFixed(1)}ms at N=${n}`).toBeLessThan(OFF_LERP_MS * (n / 1_000_000) + 2);
  }
}

describe("position transition — per-frame cost vs a streamed layout frame (#328)", () => {
  it("N=100k: no style pass, no allocation of its own, within the streamed frame's budget (LOD on and off)", () => {
    guard(100_000, "100k");
  });

  (BENCH ? it : it.skip)(`bench: the same at ${BENCH_N.toLocaleString()} nodes`, () => {
    guard(BENCH_N, `${BENCH_N}`);
  }, 600_000);
});
