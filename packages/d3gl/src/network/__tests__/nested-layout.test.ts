import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import { nestedLayout, type NestedLayoutTopology } from "../nested-layout.js";
import type { LODTree } from "../lod.js";

/** Children of tree node `g`. */
function kids(tree: LODTree, g: number): number[] {
  return Array.from(tree.children.slice(tree.childOffset[g]!, tree.childOffset[g + 1]!));
}

function rootOf(tree: LODTree): number {
  const parent = tree.parent;
  if (!parent) throw new Error("module trees carry a parent map");
  for (let g = 0; g < tree.size; g++) if (parent[g]! < 0) return g;
  throw new Error("no root");
}

/**
 * Two-level map: 4 top modules × 6 leaves. Modules 1↔2 and 3↔4 are strongly linked; 1–3 weakly. Leaves
 * are chained inside each module. Only `.ftree`-style data: leaf links inside modules + module links.
 */
function twoLevel(): { tree: LODTree; nodeCount: number } {
  const records: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let m = 0; m < 4; m++) {
    for (let j = 0; j < 6; j++) {
      const id = m * 6 + j;
      records.push({ id, path: [m + 1, j + 1] });
      if (j > 0) {
        source.push(id - 1);
        target.push(id);
        weight.push(1);
      }
    }
  }
  const links: ModuleLink[] = [
    { source: [1], target: [2], flow: 1 },
    { source: [3], target: [4], flow: 1 },
    { source: [1], target: [3], flow: 0.01 },
  ];
  return { tree: buildModuleLODTree(24, records, { source, target, weight }, links), nodeCount: 24 };
}

describe("nestedLayout (#324)", () => {
  const { tree, nodeCount } = twoLevel();
  const out = nestedLayout(tree);
  const root = rootOf(tree);
  const [m1, m2, m3, m4] = kids(tree, root).sort((a, b) => a - b);
  const dist = (a: number, b: number): number => Math.hypot(out.cx[a]! - out.cx[b]!, out.cy[a]! - out.cy[b]!);

  it("returns a position for every leaf", () => {
    expect(out.positions).toHaveLength(2 * nodeCount);
    expect(Array.from(out.positions).every(Number.isFinite)).toBe(true);
  });

  it("keeps every child disc inside its parent's disc", () => {
    const parent = tree.parent!;
    for (let g = 0; g < tree.size; g++) {
      const p = parent[g]!;
      if (p < 0) continue;
      expect(dist(g, p) + out.r[g]!).toBeLessThanOrEqual(out.r[p]! * 1.0001);
    }
  });

  it("places each leaf inside all of its ancestors' discs", () => {
    const parent = tree.parent!;
    for (let i = 0; i < nodeCount; i++) {
      for (let g = parent[i]!; g >= 0; g = parent[g]!) {
        const d = Math.hypot(out.positions[2 * i]! - out.cx[g]!, out.positions[2 * i + 1]! - out.cy[g]!);
        expect(d).toBeLessThanOrEqual(out.r[g]!);
      }
    }
  });

  it("does not overlap sibling discs", () => {
    for (let g = tree.leafCount; g < tree.size; g++) {
      const c = kids(tree, g);
      for (let a = 0; a < c.length; a++) {
        for (let b = a + 1; b < c.length; b++) {
          expect(dist(c[a]!, c[b]!)).toBeGreaterThanOrEqual((out.r[c[a]!]! + out.r[c[b]!]!) * 0.98);
        }
      }
    }
  });

  it("places strongly linked siblings closer than weakly or unlinked ones", () => {
    expect(dist(m1!, m2!)).toBeLessThan(dist(m1!, m4!));
    expect(dist(m3!, m4!)).toBeLessThan(dist(m2!, m3!));
  });

  it("is deterministic", () => {
    expect(Array.from(nestedLayout(tree).positions)).toEqual(Array.from(out.positions));
  });

  it("sizes discs by the size metric", () => {
    const size = new Float32Array(nodeCount).fill(1);
    for (let j = 0; j < 6; j++) size[j] = 10; // module 1 gets 10× the metric of each other module
    const sized = nestedLayout(tree, { size });
    expect(sized.r[m1!]! / sized.r[m2!]!).toBeCloseTo(Math.sqrt(10), 1);
  });

  it("streams depths top-down, leaves collapsed to their placed ancestor", () => {
    const depths: number[] = [];
    let firstFrame: Float32Array | null = null;
    nestedLayout(tree, {
      onDepth: (depth, positions) => {
        depths.push(depth);
        firstFrame ??= positions.slice();
      },
    });
    expect(depths).toEqual([1, 2]);
    // After depth 1 every leaf of module 1 sits at module 1's centre.
    const frame = firstFrame as Float32Array | null;
    expect(frame?.[0]).toBeCloseTo(out.cx[m1!]!);
    expect(frame?.[10]).toBeCloseTo(out.cx[m1!]!);
  });
});

/** A module tree as the layout's topology — module trees always carry their parent map. */
function topo(tree: LODTree): NestedLayoutTopology {
  const { parent } = tree;
  if (!parent) throw new Error("module trees carry a parent map");
  return { ...tree, parent };
}

/**
 * Three-level map: `T` top modules × `S` sub-modules × `L` leaves, leaves chained inside each
 * sub-module, sub-modules linked in a ring inside each top module, top modules in a ring of
 * alternating strong/weak links.
 */
function threeLevel(T: number, S: number, L: number): LODTree {
  const records: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  const n = T * S * L;
  for (let id = 0; id < n; id++) {
    records.push({ id, path: [Math.floor(id / (S * L)) + 1, Math.floor((id % (S * L)) / L) + 1, (id % L) + 1] });
    if (id % L) {
      source.push(id - 1);
      target.push(id);
      weight.push(1);
    }
  }
  const links: ModuleLink[] = [];
  for (let t = 0; t < T; t++) {
    links.push({ source: [t + 1], target: [((t + 1) % T) + 1], flow: t % 2 ? 1 : 0.05 });
    for (let s = 0; s < S; s++) links.push({ source: [t + 1, s + 1], target: [t + 1, ((s + 1) % S) + 1], flow: 1 });
  }
  return buildModuleLODTree(n, records, { source, target, weight }, links);
}

/**
 * A planted partition over one graph, clustered three ways — the shape of a re-clustering: 8 groups
 * of 12 nodes (dense inside a group, moderate between partner groups 2g ↔ 2g+1, sparse otherwise),
 * as 8 flat modules (`flat`), as 4 merged partner pairs of 2 sub-modules (`merged`), and as 8 modules
 * of 3 sub-modules (`split`). Every tree's links come from the same leaf edges.
 */
function reclustered(): { flat: LODTree; merged: LODTree; split: LODTree } {
  const G = 8;
  const K = 12;
  const n = G * K;
  let seed = 11;
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const ga = Math.floor(a / K);
      const gb = Math.floor(b / K);
      const p = ga === gb ? 0.5 : ga >> 1 === gb >> 1 ? 0.08 : ga >> 2 === gb >> 2 ? 0.015 : 0.003;
      if (rnd() < p) {
        source.push(a);
        target.push(b);
        weight.push(1);
      }
    }
  }
  const flat: ModuleNode[] = [];
  const merged: ModuleNode[] = [];
  const split: ModuleNode[] = [];
  for (let id = 0; id < n; id++) {
    const g = Math.floor(id / K);
    const j = id % K;
    flat.push({ id, path: [g + 1, j + 1] });
    merged.push({ id, path: [(g >> 1) + 1, (g & 1) + 1, j + 1] });
    split.push({ id, path: [g + 1, (j >> 2) + 1, (j & 3) + 1] });
  }
  const edges = { source, target, weight };
  return {
    flat: buildModuleLODTree(n, flat, edges),
    merged: buildModuleLODTree(n, merged, edges),
    split: buildModuleLODTree(n, split, edges),
  };
}

type Layout = ReturnType<typeof nestedLayout>;

/** Mean leaf displacement between two layouts. */
function meanShift(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length / 2; i++) s += Math.hypot(a[2 * i]! - b[2 * i]!, a[2 * i + 1]! - b[2 * i + 1]!);
  return s / (a.length / 2);
}

/** Leaf centroid and RMS spread around it. */
function spreadOf(p: ArrayLike<number>): { x: number; y: number; rms: number } {
  const n = p.length / 2;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += p[2 * i]!;
    y += p[2 * i + 1]!;
  }
  x /= n;
  y /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (p[2 * i]! - x) ** 2 + (p[2 * i + 1]! - y) ** 2;
  return { x, y, rms: Math.sqrt(ss / n) };
}

/** `p` rotated by `angle` and scaled by `scale` about its centroid, then translated by (dx, dy). */
function similar(p: Float32Array, angle: number, scale = 1, dx = 0, dy = 0): Float32Array {
  const { x, y } = spreadOf(p);
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length / 2; i++) {
    const u = p[2 * i]! - x;
    const v = p[2 * i + 1]! - y;
    out[2 * i] = x + dx + c * u - s * v;
    out[2 * i + 1] = y + dy + s * u + c * v;
  }
  return out;
}

/** The layout invariants: every child disc inside its parent's, no two sibling discs overlapping. */
function expectNested(tree: LODTree, out: Layout): void {
  const parent = tree.parent!;
  const dist = (a: number, b: number): number => Math.hypot(out.cx[a]! - out.cx[b]!, out.cy[a]! - out.cy[b]!);
  expect(Array.from(out.positions).every(Number.isFinite)).toBe(true);
  for (let g = 0; g < tree.size; g++) {
    const p = parent[g]!;
    if (p >= 0) expect(dist(g, p) + out.r[g]!).toBeLessThanOrEqual(out.r[p]! * 1.0001);
  }
  for (let g = tree.leafCount; g < tree.size; g++) {
    const c = kids(tree, g);
    for (let a = 0; a < c.length; a++) {
      for (let b = a + 1; b < c.length; b++) expect(dist(c[a]!, c[b]!)).toBeGreaterThanOrEqual((out.r[c[a]!]! + out.r[c[b]!]!) * 0.98);
    }
  }
}

/**
 * How closely linked siblings sit: per module with ≥3 children, the flow-weighted mean distance of its
 * sibling links over the mean distance of all sibling pairs (lower = links pulled tighter), averaged.
 */
function linkTightness(tree: LODTree, out: Layout): number {
  const { superEdgeOffset, superEdgeTarget, superEdgeFlow } = tree;
  if (!superEdgeOffset || !superEdgeTarget || !superEdgeFlow) throw new Error("module trees carry super-edges");
  const dist = (a: number, b: number): number => Math.hypot(out.cx[a]! - out.cx[b]!, out.cy[a]! - out.cy[b]!);
  let sum = 0;
  let modules = 0;
  for (let g = tree.leafCount; g < tree.size; g++) {
    const c = kids(tree, g);
    if (c.length < 3) continue;
    const siblings = new Set(c);
    let flow = 0;
    let linked = 0;
    let all = 0;
    let pairs = 0;
    for (const a of c) {
      for (let e = superEdgeOffset[a]!; e < superEdgeOffset[a + 1]!; e++) {
        const b = superEdgeTarget[e]!;
        if (b === a || !siblings.has(b)) continue;
        flow += superEdgeFlow[e]!;
        linked += superEdgeFlow[e]! * dist(a, b);
      }
      for (const b of c) {
        if (b <= a) continue;
        all += dist(a, b);
        pairs++;
      }
    }
    if (flow > 0) {
      sum += linked / flow / (all / pairs);
      modules++;
    }
  }
  return sum / modules;
}

describe("nestedLayout warm start (#328)", () => {
  const tree = threeLevel(12, 6, 10);
  const R = 10 * Math.sqrt(tree.leafCount);
  const cold = nestedLayout(topo(tree));

  it("moves nodes little when warm-started from its own nested layout", () => {
    const warm = nestedLayout(topo(tree), { initial: cold.positions });
    // Measured 0.037·R. A cold re-solve from any other seed moves them ~0.75·R (see the rotation test).
    expect(meanShift(warm.positions, cold.positions)).toBeLessThan(0.06 * R);
    // …and repeated warm starts settle rather than drift: the second moves less than the first.
    const again = nestedLayout(topo(tree), { initial: warm.positions });
    expect(meanShift(again.positions, warm.positions)).toBeLessThan(meanShift(warm.positions, cold.positions));
    expectNested(tree, warm);
  });

  it("follows the current arrangement — a rotated map stays rotated, where a cold start ignores it", () => {
    const rotated = similar(cold.positions, Math.PI / 2);
    const warm = nestedLayout(topo(tree), { initial: rotated });
    expect(meanShift(warm.positions, rotated)).toBeLessThan(0.06 * R);
    expect(meanShift(cold.positions, rotated)).toBeGreaterThan(0.5 * R);
  });

  it("keeps the map where it is: the leaves keep their centroid and RMS spread", () => {
    const moved = similar(cold.positions, 1, 0.3, 500, -300); // rotated, shrunk and shifted
    const before = spreadOf(moved);
    const after = spreadOf(nestedLayout(topo(tree), { initial: moved }).positions);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    expect(after.rms / before.rms).toBeCloseTo(1, 4);
  });

  it("an explicit radius sizes the root disc; the centroid still follows the current map", () => {
    const moved = similar(cold.positions, 0, 1, 200, 100);
    const warm = nestedLayout(topo(tree), { initial: moved, radius: 50 });
    expect(warm.r[rootOf(tree)]).toBeCloseTo(50, 3);
    const after = spreadOf(warm.positions);
    const before = spreadOf(moved);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  it("is deterministic", () => {
    const initial = similar(cold.positions, 0.4);
    expect(Array.from(nestedLayout(topo(tree), { initial }).positions)).toEqual(Array.from(nestedLayout(topo(tree), { initial }).positions));
  });

  it("gives exactly the cold layout from all-coincident positions (a graph never laid out)", () => {
    const warm = nestedLayout(topo(tree), { initial: new Float32Array(2 * tree.leafCount) });
    expect(Array.from(warm.positions)).toEqual(Array.from(cold.positions));
    expect(Array.from(warm.r)).toEqual(Array.from(cold.r));
  });

  it("treats non-finite coordinates as unknown", () => {
    const initial = similar(cold.positions, 0.2);
    for (let i = 0; i < 40; i++) initial[2 * i] = Number.NaN; // the first four sub-modules' leaves
    initial[2 * 300 + 1] = Number.POSITIVE_INFINITY;
    expectNested(tree, nestedLayout(topo(tree), { initial }));
  });

  it("does not stream depths — they would collapse the leaves onto their module centres", () => {
    let frames = 0;
    nestedLayout(topo(tree), { initial: cold.positions, onDepth: () => frames++ });
    expect(frames).toBe(0);
  });

  it("keeps linked siblings closer after a warm start from the same hierarchy", () => {
    const { tree: small } = twoLevel();
    const warm = nestedLayout(topo(small), { initial: nestedLayout(topo(small)).positions });
    const [m1, m2, m3, m4] = kids(small, rootOf(small)).sort((a, b) => a - b);
    const dist = (a: number, b: number): number => Math.hypot(warm.cx[a]! - warm.cx[b]!, warm.cy[a]! - warm.cy[b]!);
    expect(dist(m1!, m2!)).toBeLessThan(dist(m1!, m4!));
    expect(dist(m3!, m4!)).toBeLessThan(dist(m2!, m3!));
    expectNested(small, warm);
  });

  it("re-clusters well: invariants hold and links pull as tight as in a cold layout", () => {
    const { flat, merged, split } = reclustered();
    const before = nestedLayout(topo(flat));
    for (const next of [merged, split]) {
      const warm = nestedLayout(topo(next), { initial: before.positions });
      const fresh = nestedLayout(topo(next));
      expectNested(next, warm);
      // Measured (warm vs cold): merged 0.887 vs 0.906, split 0.922 vs 0.934 — on par or tighter.
      expect(linkTightness(next, warm)).toBeLessThan(linkTightness(next, fresh) + 0.02);
      // …and it is a refinement: the leaves move less than a cold re-layout moves them.
      expect(meanShift(warm.positions, before.positions)).toBeLessThan(meanShift(fresh.positions, before.positions));
    }
  });
});
