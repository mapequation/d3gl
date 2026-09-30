import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import { computeLODPositions, type BoundaryDiscs, type LODTree } from "../lod.js";
import { NESTED, nestedLayout, nestedBoundaryDiscs, type NestedLayoutTopology } from "../nested-layout.js";
import { NestedDrag, NestedDragCache, childRadii } from "../nested-drag.js";

/** The flat drag's re-cool budget (`Network.DRAG_COOL_FRAMES`), which the engine's drag loop passes. */
const COOL = 90;

/** Release `drag` and tick it as the engine's drag loop does: until converged or the budget is spent. */
function cool(drag: NestedDrag, positions: Float32Array, tree?: LODTree): number {
  drag.release(COOL);
  let ticks = 0;
  for (let t = COOL; t > 0; t--) {
    drag.tick(positions, tree ?? null);
    ticks++;
    if (drag.converged) break;
  }
  return ticks;
}

/**
 * The nested drag reheat (`nested-drag.ts`): a drag re-solves only the grabbed node's module (or, for a
 * module aggregate, its parent) around the held node, inside the module's disc, and leaves the rest of the
 * map — and every disc but the moved siblings' — where it is.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

interface Map {
  tree: LODTree;
  topo: NestedLayoutTopology;
  positions: Float32Array;
  discs: BoundaryDiscs;
  /** The layout's per-node radii (leaves included). */
  r: Float32Array;
  size: Float32Array;
}

/** A regular map: `branch[d]` children per module at depth d, leaf edges inside bottom modules, and
 *  module links between siblings at every level. Laid out by the CPU nested layout. */
function nestedMap(branch: number[], seed = 3): Map {
  const r = rng(seed);
  const records: ModuleNode[] = [];
  const links: ModuleLink[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  const grow = (prefix: number[], depth: number): void => {
    const k = branch[depth]!;
    if (depth === branch.length - 1) {
      const lo = records.length;
      for (let i = 1; i <= k; i++) records.push({ id: records.length, path: [...prefix, i] });
      for (let i = 0; i < 2 * k; i++) {
        const a = lo + Math.floor(r() * k);
        const b = lo + Math.floor(r() * k);
        if (a !== b) {
          source.push(a);
          target.push(b);
          weight.push(1 + r());
        }
      }
      return;
    }
    for (let i = 1; i <= k; i++) grow([...prefix, i], depth + 1);
    for (let i = 0; i < k; i++) {
      const a = 1 + Math.floor(r() * k);
      const b = 1 + Math.floor(r() * k);
      if (a !== b) links.push({ source: [...prefix, a], target: [...prefix, b], flow: 1 + 9 * r() });
    }
  };
  grow([], 0);
  const n = records.length;
  const tree = buildModuleLODTree(n, records, { source, target, weight }, links);
  const parent = tree.parent;
  if (!parent) throw new Error("module tree without parents");
  const topo = { ...tree, parent };
  const size = Float32Array.from({ length: n }, () => 0.2 + r());
  const result = nestedLayout(topo, { size, iterations: 60 });
  return { tree, topo, positions: result.positions, discs: nestedBoundaryDiscs(topo, result), r: result.r, size };
}

/** Every leaf under tree node `g`. */
function leavesOf(m: Map, g: number): number[] {
  const out: number[] = [];
  const stack = [g];
  while (stack.length) {
    const v = stack.pop()!;
    if (v < m.tree.leafCount) out.push(v);
    else for (let p = m.tree.childOffset[v]!; p < m.tree.childOffset[v + 1]!; p++) stack.push(m.tree.children[p]!);
  }
  return out;
}

/** The disc centre of module `g`: its leaf centroid plus its offset, as the LOD position pass places it. */
function discCentre(m: Map, positions: Float32Array, g: number): [number, number] {
  const leaves = leavesOf(m, g);
  let x = 0;
  let y = 0;
  for (const i of leaves) {
    x += positions[2 * i]!;
    y += positions[2 * i + 1]!;
  }
  const o = g - m.tree.leafCount;
  return [x / leaves.length + m.discs.dx[o]!, y / leaves.length + m.discs.dy[o]!];
}

/** `g` and its ancestors, up to the root. */
function chainOf(m: Map, g: number): number[] {
  const out: number[] = [];
  for (let a = g; a >= 0; a = m.tree.parent![a]!) out.push(a);
  return out;
}

const kids = (m: Map, g: number): number[] => Array.from(m.tree.children.subarray(m.tree.childOffset[g]!, m.tree.childOffset[g + 1]!));

/** A world centre per child of `g`: a leaf's position, a module's disc centre. */
function childCentres(m: Map, positions: Float32Array, g: number): [number, number][] {
  return kids(m, g).map((c) => (c < m.tree.leafCount ? [positions[2 * c]!, positions[2 * c + 1]!] : discCentre(m, positions, c)));
}

function radiusOf(m: Map, c: number): number {
  return c < m.tree.leafCount ? m.r[c]! : m.discs.r[c - m.tree.leafCount]!;
}

describe("nested drag reheat", () => {
  it("recovers every child's disc radius from the layout", () => {
    const m = nestedMap([4, 5, 12]);
    const cache = new NestedDragCache(m.topo, m.size);
    const counts = cache.leafCounts();
    for (let g = m.tree.leafCount; g < m.tree.size; g++) {
      const cs = kids(m, g);
      const R = m.discs.r[g - m.tree.leafCount]!;
      const [Cx, Cy] = discCentre(m, m.positions, g);
      const centres = childCentres(m, m.positions, g);
      const weight = Float64Array.from(cs, (c) => leavesOf(m, c).reduce((s, i) => s + m.size[i]!, 0));
      const dist = Float64Array.from(centres, ([x, y]) => Math.hypot(x - Cx, y - Cy));
      // Leaves only: the recovery by the fit, with no module child to read the scale from.
      const moduleR = new Float64Array(cs.length).fill(NaN);
      const got = childRadii(R, weight, dist, moduleR);
      cs.forEach((c, i) => expect(Math.abs(got[i]! - radiusOf(m, c)) / radiusOf(m, c)).toBeLessThan(1e-3));
      expect(counts[g]).toBe(leavesOf(m, g).length);
    }
  });

  it("re-solves every level around a dragged leaf with only the leaf pinned: discs and siblings all respond", () => {
    const m = nestedMap([3, 4, 16]);
    const cache = new NestedDragCache(m.topo, m.size);
    const leaf = 20;
    const P = m.tree.parent![leaf]!; // a bottom module
    const up = m.tree.parent![P]!; // a top module
    const root = m.tree.parent![up]!;
    const R = m.discs.r[P - m.tree.leafCount]!;
    const x0 = m.positions[2 * leaf]!;
    const y0 = m.positions[2 * leaf + 1]!;
    const radii0 = m.discs.r.slice();
    const centres0 = new Map([P, up, root].map((g) => [g, discCentre(m, m.positions, g)] as const));
    const kidCentres0 = new Map([up, root].map((g) => [g, childCentres(m, m.positions, g)] as const));
    computeLODPositions(m.tree, m.positions, m.discs);
    const drag = NestedDrag.start(cache, m.discs, m.positions, [leaf])!;
    // Every module from the leaf's up to the root is re-solved, deepest first.
    expect(drag.modules.map((x) => x.g)).toEqual(chainOf(m, P));
    drag.setDelta(2 * R, R);
    for (let t = 0; t < 80; t++) drag.tick(m.positions, m.tree);
    // Only the leaf is pinned: exactly under the cursor.
    expect(m.positions[2 * leaf]).toBeCloseTo(x0 + 2 * R, 2);
    expect(m.positions[2 * leaf + 1]).toBeCloseTo(y0 + R, 2);
    // Its module's disc followed it, and so did the discs above; every disc holds its children.
    for (const g of [P, up, root]) {
      const c = discCentre(m, m.positions, g);
      const c0 = centres0.get(g)!;
      expect(Math.hypot(c[0] - c0[0], c[1] - c0[1]), `disc ${g} did not move`).toBeGreaterThan(1e-3 * R);
    }
    // A disc keeps its laid-out radius, or grows to its members' extent: never smaller.
    m.discs.r.forEach((r, o) => expect(r).toBeGreaterThanOrEqual(radii0[o]! * (1 - 1e-6)));
    for (const g of chainOf(m, P)) {
      const R_g = m.discs.r[g - m.tree.leafCount]!;
      const cg = discCentre(m, m.positions, g);
      childCentres(m, m.positions, g).forEach(([x, y], i) => {
        const c = kids(m, g)[i]!;
        if (c === leaf) return;
        expect(Math.hypot(x - cg[0], y - cg[1]) + radiusOf(m, c)).toBeLessThanOrEqual(R_g * (1 + 1e-3));
      });
    }
    // The sibling modules respond at the parent level and at the grandparent level.
    for (const g of [up, root]) {
      const before = kidCentres0.get(g)!;
      const now = childCentres(m, m.positions, g);
      let moved = 0;
      kids(m, g).forEach((c, i) => {
        if (c === P || c === up) return;
        if (Math.hypot(now[i]![0] - before[i]![0], now[i]![1] - before[i]![1]) > 1e-3 * R) moved++;
      });
      expect(moved, `no sibling module moved in ${g}`).toBeGreaterThan(0);
    }
    // The LOD geometry is what a fresh position pass places.
    const cx = m.tree.cx.slice();
    const cy = m.tree.cy.slice();
    computeLODPositions(m.tree, m.positions, m.discs);
    for (let g = 0; g < m.tree.size; g++) {
      expect(Math.abs(cx[g]! - m.tree.cx[g]!), `node ${g}`).toBeLessThan(1e-3 * R);
      expect(Math.abs(cy[g]! - m.tree.cy[g]!), `node ${g}`).toBeLessThan(1e-3 * R);
    }
    // Released: nothing jumps — the first cool tick moves no leaf further than a held tick did.
    const held = m.positions.slice();
    drag.tick(m.positions, m.tree);
    let heldStep = 0;
    for (let i = 0; i < m.tree.leafCount; i++) heldStep = Math.max(heldStep, Math.hypot(m.positions[2 * i]! - held[2 * i]!, m.positions[2 * i + 1]! - held[2 * i + 1]!));
    drag.release(COOL);
    const released = m.positions.slice();
    drag.tick(m.positions, m.tree);
    let step = 0;
    for (let i = 0; i < m.tree.leafCount; i++) step = Math.max(step, Math.hypot(m.positions[2 * i]! - released[2 * i]!, m.positions[2 * i + 1]! - released[2 * i + 1]!));
    expect(step).toBeLessThan(Math.max(2 * heldStep, 0.05 * R));
    let ticks = 0;
    for (; ticks < COOL && !drag.converged; ticks++) drag.tick(m.positions, m.tree);
    expect(ticks).toBeLessThanOrEqual(COOL);
  });

  it("drags a module aggregate: its siblings move as a whole", () => {
    const m = nestedMap([3, 5, 10]);
    const cache = new NestedDragCache(m.topo, m.size);
    const M = m.tree.parent![0]!; // a bottom module
    const P = m.tree.parent![M]!;
    const held = leavesOf(m, M);
    const before = m.positions.slice();
    const offsets = { dx: m.discs.dx.slice(), dy: m.discs.dy.slice() };
    const drag = NestedDrag.start(cache, m.discs, m.positions, held)!;
    expect(drag.modules.map((x) => x.g)).toEqual(chainOf(m, P));
    const [Cx, Cy] = discCentre(m, m.positions, P);
    const [Mx, My] = discCentre(m, m.positions, M);
    drag.setDelta(Cx - Mx, Cy - My); // to the parent's centre
    for (let t = 0; t < 150; t++) drag.tick(m.positions);
    // Each sibling module translated rigidly: its leaves kept their offsets from each other.
    for (const c of kids(m, P)) {
      const ls = leavesOf(m, c);
      const ux = m.positions[2 * ls[0]!]! - before[2 * ls[0]!]!;
      const uy = m.positions[2 * ls[0]! + 1]! - before[2 * ls[0]! + 1]!;
      for (const i of ls) {
        expect(m.positions[2 * i]! - before[2 * i]!).toBeCloseTo(ux, 1);
        expect(m.positions[2 * i + 1]! - before[2 * i + 1]!).toBeCloseTo(uy, 1);
      }
      // Its own disc offset is unchanged (its ring rides along).
      expect(m.discs.dx[c - m.tree.leafCount]).toBe(offsets.dx[c - m.tree.leafCount]);
    }
    // The held module is at the cursor.
    const [mx, my] = discCentre(m, m.positions, M);
    expect(Math.hypot(mx - Cx, my - Cy)).toBeLessThan(1e-2 * m.discs.r[P - m.tree.leafCount]!);
  });

  it("translates the module tree's LOD geometry exactly as a fresh position pass places it", () => {
    const m = nestedMap([3, 4, 12]);
    const cache = new NestedDragCache(m.topo, m.size);
    computeLODPositions(m.tree, m.positions, m.discs);
    const M = m.tree.parent![7]!;
    const drag = NestedDrag.start(cache, m.discs, m.positions, leavesOf(m, M))!;
    drag.setDelta(30, -20);
    for (let t = 0; t < 40; t++) drag.tick(m.positions, m.tree);
    const cx = m.tree.cx.slice();
    const cy = m.tree.cy.slice();
    computeLODPositions(m.tree, m.positions, m.discs);
    const R = m.discs.r[m.tree.size - 1 - m.tree.leafCount]!;
    for (let g = 0; g < m.tree.size; g++) {
      expect(Math.abs(cx[g]! - m.tree.cx[g]!), `node ${g}`).toBeLessThan(1e-4 * R);
      expect(Math.abs(cy[g]! - m.tree.cy[g]!), `node ${g}`).toBeLessThan(1e-4 * R);
    }
  });

  it("re-solves each module a selection spans, and a whole-map grab has none", () => {
    const m = nestedMap([3, 4, 8]);
    const cache = new NestedDragCache(m.topo, m.size);
    const a = 0;
    const b = m.tree.leafCount - 1;
    const drag = NestedDrag.start(cache, m.discs, m.positions, [a, b])!;
    expect(new Set(drag.modules.map((x) => x.g))).toEqual(new Set([...chainOf(m, m.tree.parent![a]!), ...chainOf(m, m.tree.parent![b]!)]));
    const all = Array.from({ length: m.tree.leafCount }, (_, i) => i);
    expect(NestedDrag.start(cache, m.discs, m.positions, all)).toBeNull();
  });

  it("cools after release and then stops", () => {
    const m = nestedMap([3, 4, 16]);
    const cache = new NestedDragCache(m.topo, m.size);
    const drag = NestedDrag.start(cache, m.discs, m.positions, [3])!;
    drag.setDelta(15, 10);
    for (let t = 0; t < 30; t++) {
      drag.tick(m.positions);
      expect(drag.converged, "converged while held").toBe(false);
    }
    const ticks = cool(drag, m.positions);
    expect(ticks).toBeLessThanOrEqual(COOL);
  });

  it("settles on release, so a later grab moves nothing", () => {
    const m = nestedMap([3, 4, 16]);
    const cache = new NestedDragCache(m.topo, m.size);
    const R = m.discs.r[m.tree.size - 1 - m.tree.leafCount]!;
    const first = NestedDrag.start(cache, m.discs, m.positions, [5])!;
    first.setDelta(0.3 * R, 0.1 * R);
    for (let t = 0; t < 60; t++) first.tick(m.positions);
    cool(first, m.positions);
    const settled = m.positions.slice();
    const second = NestedDrag.start(cache, m.discs, m.positions, [m.tree.leafCount - 3])!;
    for (let t = 0; t < 30; t++) second.tick(m.positions);
    let most = 0;
    for (let i = 0; i < settled.length; i++) most = Math.max(most, Math.abs(m.positions[i]! - settled[i]!));
    expect(most, "a later grab released what the first drag left").toBeLessThan(1e-3 * R);
  });
});
