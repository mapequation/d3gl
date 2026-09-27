/**
 * Module-tree fixtures and layout checks shared by the CPU nested layout's tests (`nested-layout.test.ts`)
 * and the batched GPU port's (`gpu/__tests__/gpu-nested-layout.browser.test.ts`, #355), so both hold the
 * same layouts to the same invariants.
 */
import { expect } from "vitest";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import type { NestedLayoutResult, NestedLayoutTopology } from "../nested-layout.js";
import type { LODTree } from "../lod.js";

/** Children of tree node `g`. */
export function kids(tree: LODTree, g: number): number[] {
  return Array.from(tree.children.slice(tree.childOffset[g]!, tree.childOffset[g + 1]!));
}

export function rootOf(tree: LODTree): number {
  const parent = tree.parent;
  if (!parent) throw new Error("module trees carry a parent map");
  for (let g = 0; g < tree.size; g++) if (parent[g]! < 0) return g;
  throw new Error("no root");
}

/**
 * Two-level map: 4 top modules × 6 leaves. Modules 1↔2 and 3↔4 are strongly linked; 1–3 weakly. Leaves
 * are chained inside each module. Only `.ftree`-style data: leaf links inside modules + module links.
 */
export function twoLevel(): { tree: LODTree; nodeCount: number } {
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

/** A module tree as the layout's topology — module trees always carry their parent map. */
export function topo(tree: LODTree): NestedLayoutTopology {
  const { parent } = tree;
  if (!parent) throw new Error("module trees carry a parent map");
  return { ...tree, parent };
}

/**
 * Three-level map: `T` top modules × `S` sub-modules × `L` leaves, leaves chained inside each
 * sub-module, sub-modules linked in a ring inside each top module, top modules in a ring of
 * alternating strong/weak links.
 */
export function threeLevel(T: number, S: number, L: number): LODTree {
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
export function reclustered(): { flat: LODTree; merged: LODTree; split: LODTree } {
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

type Layout = Pick<NestedLayoutResult, "positions" | "cx" | "cy" | "r">;

/** Mean leaf displacement between two layouts. */
export function meanShift(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length / 2; i++) s += Math.hypot(a[2 * i]! - b[2 * i]!, a[2 * i + 1]! - b[2 * i + 1]!);
  return s / (a.length / 2);
}

/** Leaf centroid and RMS spread around it. */
export function spreadOf(p: ArrayLike<number>): { x: number; y: number; rms: number } {
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
export function similar(p: Float32Array, angle: number, scale = 1, dx = 0, dy = 0): Float32Array {
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
export function expectNested(tree: LODTree, out: Layout): void {
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
export function linkTightness(tree: LODTree, out: Layout): number {
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

