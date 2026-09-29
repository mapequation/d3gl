import { describe, it, expect, beforeAll } from "vitest";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import { computeLODPositions, type BoundaryDiscs, type LODTree } from "../lod.js";
import { nestedBoundaryDiscs, type NestedLayoutTopology } from "../nested-layout.js";
import { NestedDrag, NestedDragCache } from "../nested-drag.js";

/**
 * Per-frame guard for the nested drag reheat (AGENTS.md lifecycle §5: a node drag is a per-frame path).
 * One tick runs per animation frame. Every level above the dragged item re-solves at the drag heat, so a
 * tick moves the whole map as a flat reheat does: its work is O(the re-solved modules' children and
 * links + the nodes that moved), each moved leaf written once (and each LOD tree node once, with LOD on) —
 * no pass beyond that. At ≈1M leaves (always on: the map is built directly, not laid out) on a
 * 100 × 100 × 100 module tree with leaf edges in the bottom modules and module links between siblings:
 * a leaf, a bottom-module and a top-module grab dragged toward their module's centre, and a leaf dragged
 * out of its module; LOD geometry on and off. Wall-clock ceilings (a tick, a grab) assert under
 * `PERF_ASSERT` (the at-scale tier, `BENCH_NESTED_DRAG`).
 */

const BENCH = !!process.env.BENCH_NESTED_DRAG;
const N = BENCH ? Number(process.env.BENCH_NESTED_DRAG_N) || 1_000_000 : 1_000_000;
const ASSERT = !!process.env.PERF_ASSERT;
const TICKS = 30;
// Measured (M1 Max, node, 1M): median tick 4.5-4.7 ms with LOD off and 6.6-6.7 ms with LOD on, for every
// grab (every level responds, so ≈1M leaves move per tick); a grab 5-18 ms (it walks the root's children:
// the whole map). Ceilings ~10×.
const TICK_MS = Number(process.env.PERF_NESTED_DRAG_TICK_MS) || 80;
const GRAB_MS = Number(process.env.PERF_NESTED_DRAG_GRAB_MS) || 150;

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

interface Fixture {
  tree: LODTree;
  topo: NestedLayoutTopology;
  positions: Float32Array;
  discs: BoundaryDiscs;
}

/** A nested map of `b³ ≈ n` leaves, placed directly: each module's children on a golden spiral inside its
 *  disc, radii by an equal area share (a valid nested map; the solve's own layout is not needed here). */
function fixture(n: number): Fixture {
  const b = Math.max(2, Math.round(Math.cbrt(n)));
  const leaves = b * b * b;
  const records: ModuleNode[] = new Array<ModuleNode>(leaves);
  const source = new Uint32Array(2 * leaves);
  const target = new Uint32Array(2 * leaves);
  const weight = new Float32Array(2 * leaves).fill(1);
  const links: ModuleLink[] = [];
  for (let i = 0; i < leaves; i++) {
    const a = Math.floor(i / (b * b));
    const m = Math.floor(i / b) % b;
    records[i] = { id: i, path: [a + 1, m + 1, (i % b) + 1] };
    const lo = i - (i % b);
    source[2 * i] = i;
    target[2 * i] = lo + ((i % b) + 1) % b;
    source[2 * i + 1] = i;
    target[2 * i + 1] = lo + ((i % b) + 7) % b;
  }
  for (let a = 1; a <= b; a++) {
    links.push({ source: [a], target: [(a % b) + 1], flow: 1 });
    for (let m = 1; m <= b; m++) links.push({ source: [a, m], target: [a, (m % b) + 1], flow: 1 });
  }
  const tree = buildModuleLODTree(leaves, records, { source, target, weight }, links);
  const parent = tree.parent;
  if (!parent) throw new Error("module tree without parents");
  const topo = { ...tree, parent };
  const cx = new Float32Array(tree.size);
  const cy = new Float32Array(tree.size);
  const r = new Float32Array(tree.size);
  const root = tree.size - 1;
  r[root] = 10 * Math.sqrt(leaves);
  for (let g = root; g >= tree.leafCount; g--) {
    const c0 = tree.childOffset[g]!;
    const k = tree.childOffset[g + 1]! - c0;
    const rc = (0.92 * r[g]!) / (1 + Math.sqrt(k)) / 1.1;
    for (let i = 0; i < k; i++) {
      const c = tree.children[c0 + i]!;
      const rr = (0.92 * r[g]! - rc) * Math.sqrt((i + 0.5) / k);
      cx[c] = cx[g]! + rr * Math.cos(i * GOLDEN);
      cy[c] = cy[g]! + rr * Math.sin(i * GOLDEN);
      r[c] = rc;
    }
  }
  const positions = new Float32Array(2 * leaves);
  for (let i = 0; i < leaves; i++) {
    positions[2 * i] = cx[i]!;
    positions[2 * i + 1] = cy[i]!;
  }
  return { tree, topo, positions, discs: nestedBoundaryDiscs(topo, { positions, cx, cy, r }) };
}

interface Leg {
  maxLeafWrites: number;
  maxNodeWrites: number;
  leavesUnder: number;
  nodesUnder: number;
  outsideChanged: number;
  medianTickMs: number;
  grabMs: number;
}

let fx: Fixture;
let cache: NestedDragCache;
const legs: Record<string, Leg> = {};

function subtree(g: number): { leaves: number; nodes: number; set: Uint8Array } {
  const set = new Uint8Array(fx.tree.leafCount);
  let leaves = 0;
  let nodes = 0;
  const stack = [g];
  while (stack.length) {
    const v = stack.pop()!;
    nodes++;
    if (v < fx.tree.leafCount) {
      leaves++;
      set[v] = 1;
    } else for (let p = fx.tree.childOffset[v]!; p < fx.tree.childOffset[v + 1]!; p++) stack.push(fx.tree.children[p]!);
  }
  return { leaves, nodes, set };
}

function leafIds(g: number): number[] {
  const out: number[] = [];
  const s = subtree(g).set;
  for (let i = 0; i < s.length; i++) if (s[i]) out.push(i);
  return out;
}

function runLeg(held: number[], lod: boolean, out = false): Leg {
  const { tree } = fx;
  const t0 = performance.now();
  const drag = NestedDrag.start(cache, fx.discs, fx.positions, held);
  const grabMs = performance.now() - t0;
  if (!drag) throw new Error("no nested drag");
  const P = drag.modules[0]!.g;
  const under = subtree(P);
  const before = fx.positions.slice();
  // Toward the module's centre, stopping short of it: the held item stays inside its module's disc, so
  // the disc does not travel and nothing above it moves (a drag out of it is `outLeg`'s).
  const centroid = (ls: ArrayLike<number>): [number, number] => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < ls.length; i++) {
      x += fx.positions[2 * ls[i]!]! / ls.length;
      y += fx.positions[2 * ls[i]! + 1]! / ls.length;
    }
    return [x, y];
  };
  const [hx, hy] = centroid(held);
  const [px, py] = centroid(leafIds(P));
  const o = P - tree.leafCount;
  let [tx, ty] = [px + fx.discs.dx[o]! - hx, py + fx.discs.dy[o]! - hy];
  if (out) {
    // Away from it, three of its radii: the disc travels along and pushes its neighbours, up the levels.
    const R = fx.discs.r[o]!;
    const d = Math.hypot(tx, ty) || 1;
    [tx, ty] = [(-3 * R * tx) / (0.8 * d), (-3 * R * ty) / (0.8 * d)];
  }
  let maxLeafWrites = 0;
  let maxNodeWrites = 0;
  const ts: number[] = [];
  for (let t = 1; t <= TICKS; t++) {
    drag.setDelta((0.8 * tx * t) / TICKS, (0.8 * ty * t) / TICKS);
    const lw = drag.stats.leafWrites;
    const nw = drag.stats.nodeWrites;
    const s = performance.now();
    drag.tick(fx.positions, lod ? tree : null);
    ts.push(performance.now() - s);
    maxLeafWrites = Math.max(maxLeafWrites, drag.stats.leafWrites - lw);
    maxNodeWrites = Math.max(maxNodeWrites, drag.stats.nodeWrites - nw);
  }
  drag.release(90); // the engine's re-cool budget (`Network.DRAG_COOL_FRAMES`)
  for (let t = 0; t < 90 && !drag.converged; t++) drag.tick(fx.positions, lod ? tree : null);
  let outsideChanged = 0;
  for (let i = 0; i < tree.leafCount; i++) {
    if (under.set[i]) continue;
    if (fx.positions[2 * i] !== before[2 * i] || fx.positions[2 * i + 1] !== before[2 * i + 1]) outsideChanged++;
  }
  ts.sort((a, b) => a - b);
  return { maxLeafWrites, maxNodeWrites, leavesUnder: under.leaves, nodesUnder: under.nodes, outsideChanged, medianTickMs: ts[ts.length >> 1]!, grabMs };
}

beforeAll(() => {
  fx = fixture(N);
  computeLODPositions(fx.tree, fx.positions, fx.discs);
  cache = new NestedDragCache(fx.topo, undefined);
  cache.leafCounts(); // built once per layout, on the first grab
  const { tree } = fx;
  const parent = tree.parent!;
  const leaf = Math.floor(tree.leafCount / 2) + 3;
  const bottom = parent[leaf]!;
  const top = parent[bottom]!;
  for (const lod of [false, true]) {
    const tag = lod ? "LOD on" : "LOD off";
    legs[`leaf, ${tag}`] = runLeg([leaf], lod);
    legs[`bottom module, ${tag}`] = runLeg(leafIds(bottom), lod);
    legs[`top module, ${tag}`] = runLeg(leafIds(top), lod);
    legs[`leaf out of its module, ${tag}`] = runLeg([leaf + 17], lod, true);
  }
}, 120_000);

describe(`nested drag reheat — per-tick cost at ${N.toLocaleString()} leaves`, () => {
  for (const name of ["leaf", "bottom module", "top module", "leaf out of its module"]) {
    for (const tag of ["LOD off", "LOD on"]) {
      it(`${name}, ${tag}: every level responds; a tick writes each moved node once, the LOD tree only with LOD on`, () => {
        const leg = legs[`${name}, ${tag}`]!;
        expect(leg.maxLeafWrites).toBeGreaterThan(0);
        expect(leg.maxLeafWrites).toBeLessThanOrEqual(fx.tree.leafCount);
        expect(leg.maxNodeWrites).toBeLessThanOrEqual(tag === "LOD on" ? fx.tree.size : 0);
        // Outside the held item's own module: the levels above respond (a top module's parent is the root).
        if (name !== "top module") expect(leg.outsideChanged, "the levels above did not respond").toBeGreaterThan(0);
      });
    }
  }

  it("a grab stays within budget", () => {
    if (ASSERT) for (const leg of Object.values(legs)) expect(leg.grabMs).toBeLessThan(GRAB_MS);
  });

  it("ticks within budget", () => {
    const report = Object.entries(legs).map(([k, l]) => `${k}: tick ${l.medianTickMs.toFixed(3)} ms, grab ${l.grabMs.toFixed(2)} ms`);
    console.log(`[nested-drag ${N}] ${report.join("; ")}`);
    if (!ASSERT) return;
    for (const leg of Object.values(legs)) expect(leg.medianTickMs).toBeLessThan(TICK_MS);
  });
});
