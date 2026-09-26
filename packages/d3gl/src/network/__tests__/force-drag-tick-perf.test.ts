import { describe, it, expect, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { DEFAULT_FORCE, DRAG_HEAT, ForceLayout, seedPositions } from "../force.js";
import { BarnesHutTree } from "../quadtree.js";
import { buildGraph, type NetworkGraph } from "../graph.js";

/**
 * Per-frame guard for the main-thread force drag (AGENTS.md lifecycle §5). With `layout({ backend:
 * "force" })` a node-drag runs one {@link ForceLayout.tick} per animation frame over the WHOLE graph
 * (network.ts: the `backend === "force"` branch of the drag session) — a continuous pointer
 * interaction, so a per-frame path. The tick is O(all nodes · log) Barnes-Hut + O(all edges) springs
 * whatever the LOD / declutter state: reductions only shrink what is drawn, never what is simulated,
 * so there is no "reductions on" regime with a smaller set to test (the drag's LOD side is
 * `lod-drag-incremental-perf.test.ts`).
 *
 * #124 put the convergence bookkeeping into every tick (one sqrt + add per node for the mean step)
 * and gave coarse multilevel levels per-node masses and per-edge spring weights. The finest tick —
 * the one the drag runs — must stay the unit-mass path: masses and weights live in separate loops.
 *
 * Signature asserted deterministically (contention-immune):
 *   1. one Barnes-Hut build per frame, over all N bodies, with NO mass array (the unit-body path);
 *   2. N repulsion traversals per frame (one per node) — not a second pass;
 *   3. the held node stays exactly under the cursor while the rest moves (the drag's contract).
 * Wall-clock (generous, catches an order-of-magnitude drop): the median drag frame at N, and the
 * frame's time over its own Barnes-Hut work (build + N traversals on the same positions, interleaved)
 * — the springs, centering, integration and step sum are O(N + E) and within that ratio's noise; a
 * second pass of Barnes-Hut scale would double it.
 *
 * N is 100k in the normal suite; the at-scale leg reads BENCH_FORCE_DRAG / BENCH_FORCE_DRAG_NODES
 * (the CI perf tier sets it to $PERF_N) and asserts its ceilings under PERF_ASSERT:
 *   BENCH_FORCE_DRAG=1 BENCH_FORCE_DRAG_NODES=1000000 npx vitest run \
 *     packages/d3gl/src/network/__tests__/force-drag-tick-perf.test.ts --no-file-parallelism
 * Appends to /tmp/force-drag-perf.txt.
 */
const BENCH = !!process.env.BENCH_FORCE_DRAG;
const BENCH_N = Number(process.env.BENCH_FORCE_DRAG_NODES) || 1_000_000;
const ASSERT = !!process.env.PERF_ASSERT;
// Calibration on an M-series laptop under heavy shared load (load avg ~7-8): 100k nodes / 200k edges,
// median drag frame ~170 ms; 500k ~1.3 s. The frame measured 0.85-0.95× its own Barnes-Hut work
// (the tick's tight loop beats the standalone one) — the springs, centering, integration and step sum
// hide in that noise. Ceilings: ~4× the frame; the ratio at 1.5 catches any added pass of
// Barnes-Hut scale (which would put it near 2) with room for contention.
const FRAME_MS_100K = Number(process.env.PERF_FORCE_DRAG_FRAME_MS) || 750;
/** Per-node share of the frame ceiling for the at-scale leg (Barnes-Hut is O(N log N); linear with slack). */
const FRAME_MS_PER_NODE = FRAME_MS_100K / 100_000;
const OVERHEAD_RATIO = Number(process.env.PERF_FORCE_DRAG_OVERHEAD) || 1.5;
const WARM_FRAMES = 2;
const FRAMES = 5;

/** Ring backbone + deterministic short-range chords (E = 2N) at the force equilibrium's scale — the
 *  density a converged layout has, so Barnes-Hut does its real per-node work. */
function dragFixture(n: number): NetworkGraph {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source = new Uint32Array(2 * n);
  const target = new Uint32Array(2 * n);
  for (let i = 0; i < n; i++) {
    source[2 * i] = i;
    target[2 * i] = (i + 1) % n;
    source[2 * i + 1] = i;
    target[2 * i + 1] = (i + 2 + Math.floor(rng() * 48)) % n;
  }
  const g = buildGraph({ nodeCount: n, source, target });
  seedPositions(g, 1280, 800, { force: {} });
  return g;
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/** One drag frame as the force backend's drag loop runs it: hold the grabbed node at the cursor, tick. */
function dragFrame(sim: ForceLayout, g: NetworkGraph, held: number, x: number, y: number): void {
  g.positions[held * 2] = x;
  g.positions[held * 2 + 1] = y;
  sim.tick();
}

interface DragRun {
  frameMs: number;
  bhMs: number;
  builds: number;
  buildBodies: number;
  buildMassArgs: number;
  traversals: number;
  heldExact: boolean;
  othersMoved: boolean;
}

function runDrag(n: number): DragRun {
  const g = dragFixture(n);
  const held = 0;
  const x0 = g.positions[0] ?? 0;
  const y0 = g.positions[1] ?? 0;
  const sim = new ForceLayout(g);
  sim.setPinned([held]);
  sim.hold(DRAG_HEAT);
  for (let f = 0; f < WARM_FRAMES; f++) dragFrame(sim, g, held, x0 + f, y0);

  // Signature frames (spied, untimed).
  const before = g.positions.slice();
  const build = vi.spyOn(BarnesHutTree.prototype, "build");
  const apply = vi.spyOn(BarnesHutTree.prototype, "applyForce");
  dragFrame(sim, g, held, x0 + 10, y0 + 5);
  const builds = build.mock.calls.length;
  const buildBodies = build.mock.calls[0]?.[1] ?? -1;
  const buildMassArgs = build.mock.calls.filter((call) => call[2] !== undefined).length;
  const traversals = apply.mock.calls.length;
  build.mockRestore();
  apply.mockRestore();
  const heldExact = g.positions[0] === Math.fround(x0 + 10) && g.positions[1] === Math.fround(y0 + 5);
  let othersMoved = false;
  for (let i = 2; i < g.positions.length && !othersMoved; i++) othersMoved = g.positions[i] !== before[i];

  // Timed frames, interleaved with the frame's own Barnes-Hut work on the same positions (build + one
  // traversal per node) so machine contention hits both sides of the overhead ratio alike.
  const tree = new BarnesHutTree();
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  const frames: number[] = [];
  const bh: number[] = [];
  for (let f = 0; f < FRAMES; f++) {
    let t0 = performance.now();
    tree.build(g.positions, n);
    for (let i = 0; i < n; i++) tree.applyForce(i, DEFAULT_FORCE.repulsion, DEFAULT_FORCE.theta, fx, fy);
    bh.push(performance.now() - t0);
    t0 = performance.now();
    dragFrame(sim, g, held, x0 + 11 + f, y0 + 5);
    frames.push(performance.now() - t0);
  }
  return { frameMs: median(frames), bhMs: median(bh), builds, buildBodies, buildMassArgs, traversals, heldExact, othersMoved };
}

function expectSignature(r: DragRun, n: number): void {
  expect(r.builds, "one Barnes-Hut build per drag frame").toBe(1);
  expect(r.buildBodies, "the build spans every node").toBe(n);
  expect(r.buildMassArgs, "the finest tick takes the unit-mass path (no mass array)").toBe(0);
  expect(r.traversals, "one repulsion traversal per node per frame").toBe(n);
  expect(r.heldExact, "the held node stays exactly under the cursor").toBe(true);
  expect(r.othersMoved, "the rest of the layout reflows").toBe(true);
}

describe("main-thread force drag tick (per-frame, lifecycle §5)", () => {
  it("a drag frame is one unit-mass Barnes-Hut tick over all nodes, within budget (100k nodes / 200k edges)", () => {
    const n = 100_000;
    const r = runDrag(n);
    expectSignature(r, n);
    expect(r.frameMs, `median drag frame ${r.frameMs.toFixed(1)} ms`).toBeLessThan(FRAME_MS_100K);
    expect(r.frameMs / r.bhMs, `frame ${r.frameMs.toFixed(1)} ms vs its Barnes-Hut ${r.bhMs.toFixed(1)} ms`).toBeLessThan(OVERHEAD_RATIO);
  });

  it.runIf(BENCH)(`bench: force drag frame at ${BENCH_N.toLocaleString()} nodes`, () => {
    const r = runDrag(BENCH_N);
    const line = `force drag N=${BENCH_N}: frame ${r.frameMs.toFixed(1)} ms, Barnes-Hut ${r.bhMs.toFixed(1)} ms, ratio ${(r.frameMs / r.bhMs).toFixed(2)}\n`;
    appendFileSync("/tmp/force-drag-perf.txt", `[${process.env.BENCH_FORCE_DRAG_LABEL ?? "run"}] ${line}`);
    expectSignature(r, BENCH_N);
    if (ASSERT) {
      const ceiling = FRAME_MS_PER_NODE * BENCH_N * Math.log2(BENCH_N) / Math.log2(100_000);
      expect(r.frameMs, `median drag frame ${r.frameMs.toFixed(1)} ms exceeds ${ceiling.toFixed(0)} ms at N=${BENCH_N}`).toBeLessThan(ceiling);
      expect(r.frameMs / r.bhMs).toBeLessThan(OVERHEAD_RATIO);
    }
  });
});
