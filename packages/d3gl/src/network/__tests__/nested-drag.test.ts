import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import { computeLODPositions, type BoundaryDiscs, type LODTree } from "../lod.js";
import { NESTED, nestedLayout, nestedBoundaryDiscs, type NestedLayoutTopology } from "../nested-layout.js";
import { NESTED_DRAG_COOL_TICKS, NestedDrag, NestedDragCache, childRadii } from "../nested-drag.js";

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

  it("re-solves only the grabbed leaf's module, inside its fixed disc", () => {
    const m = nestedMap([3, 4, 16]);
    const cache = new NestedDragCache(m.topo, m.size);
    const leaf = 5;
    const P = m.tree.parent![leaf]!;
    const R = m.discs.r[P - m.tree.leafCount]!;
    const before = m.positions.slice();
    const centre0 = discCentre(m, m.positions, P);
    const rootCentre0 = discCentre(m, m.positions, m.tree.size - 1);
    const drag = NestedDrag.start(cache, m.discs, m.positions, [leaf]);
    expect(drag).not.toBeNull();
    expect(drag!.modules.map((x) => x.g)).toEqual([P]);
    // Toward the disc centre and across it: the held leaf follows the cursor.
    const [x0, y0] = [before[2 * leaf]!, before[2 * leaf + 1]!];
    const dx = (centre0[0] - x0) * 1.5;
    const dy = (centre0[1] - y0) * 1.5;
    drag!.setDelta(dx, dy);
    for (let t = 0; t < 200; t++) drag!.tick(m.positions);
    expect(m.positions[2 * leaf]).toBeCloseTo(x0 + dx, 2);
    expect(m.positions[2 * leaf + 1]).toBeCloseTo(y0 + dy, 2);
    // The module's disc keeps its centre, and so does the root's.
    const centre1 = discCentre(m, m.positions, P);
    expect(Math.hypot(centre1[0] - centre0[0], centre1[1] - centre0[1])).toBeLessThan(1e-3 * R);
    const rootCentre1 = discCentre(m, m.positions, m.tree.size - 1);
    expect(Math.hypot(rootCentre1[0] - rootCentre0[0], rootCentre1[1] - rootCentre0[1])).toBeLessThan(1e-3 * R);
    // Every sibling inside the disc, none overlapping the held leaf (collision distance, a few % slack).
    const cs = kids(m, P);
    const centres = childCentres(m, m.positions, P);
    let moved = 0;
    cs.forEach((c, i) => {
      const [x, y] = centres[i]!;
      expect(Math.hypot(x - centre0[0], y - centre0[1]) + radiusOf(m, c)).toBeLessThanOrEqual(R * (1 + 1e-4));
      if (c === leaf) return;
      const d = Math.hypot(x - m.positions[2 * leaf]!, y - m.positions[2 * leaf + 1]!);
      expect(d).toBeGreaterThan((radiusOf(m, c) + radiusOf(m, leaf)) * NESTED.PAD * 0.95);
      if (Math.hypot(x - before[2 * c]!, y - before[2 * c + 1]!) > 1e-3 * R) moved++;
    });
    expect(moved, "no sibling made room").toBeGreaterThan(0);
    // Nothing outside the module moved.
    const inside = new Set(leavesOf(m, P));
    for (let i = 0; i < m.tree.leafCount; i++) {
      if (inside.has(i)) continue;
      expect(m.positions[2 * i]).toBe(before[2 * i]);
      expect(m.positions[2 * i + 1]).toBe(before[2 * i + 1]);
    }
    // Per tick, only the module's leaves are written.
    expect(drag!.stats.leafWrites).toBeLessThanOrEqual(drag!.stats.ticks * inside.size);
  });

  it("lets the held leaf leave its module's disc: the ring grows about its centre to enclose it", () => {
    const m = nestedMap([3, 4, 16]);
    const cache = new NestedDragCache(m.topo, m.size);
    const leaf = 20;
    const P = m.tree.parent![leaf]!;
    const o = P - m.tree.leafCount;
    const R = m.discs.r[o]!;
    const c0 = discCentre(m, m.positions, P);
    const x0 = m.positions[2 * leaf]!;
    const y0 = m.positions[2 * leaf + 1]!;
    computeLODPositions(m.tree, m.positions, m.discs);
    const drag = NestedDrag.start(cache, m.discs, m.positions, [leaf])!;
    drag.setDelta(3 * R, 0);
    for (let t = 0; t < 30; t++) drag.tick(m.positions, m.tree);
    // The leaf is exactly under the cursor, far outside the disc as laid out.
    expect(m.positions[2 * leaf]).toBeCloseTo(x0 + 3 * R, 2);
    expect(m.positions[2 * leaf + 1]).toBeCloseTo(y0, 2);
    // The disc keeps its centre and grows just enough to enclose it (ring and LOD extent alike).
    const c1 = discCentre(m, m.positions, P);
    expect(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])).toBeLessThan(1e-3 * R);
    const d = Math.hypot(m.positions[2 * leaf]! - c0[0], m.positions[2 * leaf + 1]! - c0[1]);
    expect(m.discs.r[o]).toBeCloseTo(d + m.r[leaf]!, 2);
    expect(m.tree.extent[P]).toBeCloseTo(m.discs.r[o]!, 2);
    // Its siblings stay inside the disc as laid out.
    for (const c of kids(m, P)) {
      if (c === leaf) continue;
      const cc = c < m.tree.leafCount ? [m.positions[2 * c]!, m.positions[2 * c + 1]!] : discCentre(m, m.positions, c);
      expect(Math.hypot(cc[0]! - c0[0], cc[1]! - c0[1]) + radiusOf(m, c)).toBeLessThanOrEqual(R * (1 + 1e-4));
    }
    // Dropped there, it is not snapped back — and a later grab in the module keeps it out (the ring too).
    drag.release();
    while (drag.tick(m.positions, m.tree));
    const dropped = Math.hypot(m.positions[2 * leaf]! - c0[0], m.positions[2 * leaf + 1]! - c0[1]);
    expect(dropped).toBeGreaterThan(2 * R);
    const again = NestedDrag.start(cache, m.discs, m.positions, [kids(m, P).find((c) => c !== leaf)!])!;
    for (let t = 0; t < 10; t++) again.tick(m.positions, m.tree);
    const still = Math.hypot(m.positions[2 * leaf]! - c0[0], m.positions[2 * leaf + 1]! - c0[1]);
    expect(still).toBeGreaterThan(2 * R);
    expect(m.discs.r[o]!).toBeGreaterThanOrEqual(still + m.r[leaf]! - 1e-3 * R);
    // Back inside, the ring shrinks back to its laid-out radius.
    const back = NestedDrag.start(cache, m.discs, m.positions, [leaf])!;
    back.setDelta(c0[0] - m.positions[2 * leaf]!, c0[1] - m.positions[2 * leaf + 1]!);
    for (let t = 0; t < 30; t++) back.tick(m.positions, m.tree);
    expect(m.discs.r[o]).toBeCloseTo(R, 3);
  });

  it("drags a module aggregate: its siblings move as a whole, and every other disc stays", () => {
    const m = nestedMap([3, 5, 10]);
    const cache = new NestedDragCache(m.topo, m.size);
    const M = m.tree.parent![0]!; // a bottom module
    const P = m.tree.parent![M]!;
    const held = leavesOf(m, M);
    const before = m.positions.slice();
    const offsets = { dx: m.discs.dx.slice(), dy: m.discs.dy.slice() };
    const drag = NestedDrag.start(cache, m.discs, m.positions, held)!;
    expect(drag.modules.map((x) => x.g)).toEqual([P]);
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
    // The held module is at the cursor (clamped inside P's disc).
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
    expect(new Set(drag.modules.map((x) => x.g))).toEqual(new Set([m.tree.parent![a]!, m.tree.parent![b]!]));
    const all = Array.from({ length: m.tree.leafCount }, (_, i) => i);
    expect(NestedDrag.start(cache, m.discs, m.positions, all)).toBeNull();
  });

  it("cools after release and then stops", () => {
    const m = nestedMap([3, 4, 16]);
    const cache = new NestedDragCache(m.topo, m.size);
    const drag = NestedDrag.start(cache, m.discs, m.positions, [3])!;
    drag.setDelta(15, 10);
    for (let t = 0; t < 30; t++) expect(drag.tick(m.positions)).toBe(true);
    drag.release();
    let ticks = 0;
    while (drag.tick(m.positions)) ticks++;
    expect(ticks).toBeLessThan(NESTED_DRAG_COOL_TICKS);
    const after = m.positions.slice();
    expect(drag.tick(m.positions)).toBe(false);
    expect(m.positions).toEqual(after);
  });
});
