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

/**
 * A directed partition in the shape of web-NotreDame's directed Infomap tree (#355), where hubs are small:
 * a directory page links out to many pages but few link back, so its flow — the directed PageRank Infomap
 * sizes nodes by — is little more than its teleportation share, and its disc is no larger than its
 * pages'. It then takes half or more of each of its links' correction, so its summed link share D grows
 * with its degree (about a quarter of its weighted degree at equal radii). Under undirected flow a hub's
 * disc grows with its degree instead, so its share of each link shrinks as its links multiply.
 *
 * Three top modules over 220 pages. Module 1 is a directory page linking to 150 pages that each link on
 * to module 3 only: its disc is its pages' size, so D ≈ 38 (web-NotreDame's largest: 612 links, D =
 * 135). Module 2 is two directory pages that link each other, with 24 pages each, chained: they sit at
 * the radius floor, below some of their pages, and D ≈ 3.7 each (two linked hubs, the stiffest spring
 * mode). Module 3 is 20 pages in a cycle, linking back to module 2's first pages. Nothing else links a
 * directory. The flow is the directed PageRank (teleportation 0.15; no page is dangling) — `flow` for
 * the size metric, `source` / `target` for the graph. (D is the solver's, from its sparsified link
 * weights and radii: `nested-topology.test.ts`.)
 */
export function directedPartition(): { tree: LODTree; modules: ModuleNode[]; source: number[]; target: number[]; flow: Float32Array } {
  const modules: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const link = (a: number, b: number): void => {
    source.push(a);
    target.push(b);
  };
  let id = 0;
  const page = (path: number[]): number => {
    modules.push({ id, path });
    return id++;
  };
  const directory = page([1, 1]);
  const pages = Array.from({ length: 150 }, (_, p) => page([1, p + 2]));
  const a = page([2, 1]);
  const b = page([2, 2]);
  const lists = [a, b].map((hub, h) => ({ hub, list: Array.from({ length: 24 }, (_, p) => page([2, 3 + 24 * h + p])) }));
  const cycle = Array.from({ length: 20 }, (_, p) => page([3, p + 1]));
  pages.forEach((leaf, p) => {
    link(directory, leaf);
    link(leaf, cycle[p % cycle.length] ?? leaf);
  });
  link(a, b);
  link(b, a);
  for (const { hub, list } of lists) {
    list.forEach((leaf, p) => {
      link(hub, leaf);
      link(leaf, list[p + 1] ?? cycle[0] ?? leaf); // on to the next page; the last to module 3
    });
    link(cycle[10] ?? 0, list[0] ?? 0);
  }
  cycle.forEach((leaf, p) => link(leaf, cycle[(p + 1) % cycle.length] ?? leaf));
  const n = id;
  // Directed PageRank by power iteration, teleportation 0.15 (every page links out).
  const out = new Uint32Array(n);
  for (const s of source) out[s] = (out[s] ?? 0) + 1;
  let flow = new Float64Array(n).fill(1 / n);
  for (let it = 0; it < 200; it++) {
    const next = new Float64Array(n).fill(0.15 / n);
    source.forEach((s, e) => {
      const t = target[e] ?? 0;
      next[t] = (next[t] ?? 0) + (0.85 * (flow[s] ?? 0)) / (out[s] ?? 1);
    });
    flow = next;
  }
  const weight = source.map(() => 1); // an unweighted edge list, as web-NotreDame's
  return { tree: buildModuleLODTree(n, modules, { source, target, weight }), modules, source, target, flow: Float32Array.from(flow) };
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

/** Distance between the centres of tree nodes `a` and `b`. */
function centreDistance(out: Pick<Layout, "cx" | "cy">, a: number, b: number): number {
  return Math.hypot((out.cx[a] ?? 0) - (out.cx[b] ?? 0), (out.cy[a] ?? 0) - (out.cy[b] ?? 0));
}

/** Finite positions, and every child disc inside its parent's. */
export function expectContained(tree: LODTree, out: Layout): void {
  const { parent } = tree;
  if (!parent) throw new Error("module trees carry a parent map");
  expect(Array.from(out.positions).every(Number.isFinite)).toBe(true);
  for (let g = 0; g < tree.size; g++) {
    const p = parent[g] ?? -1;
    if (p >= 0) expect(centreDistance(out, g, p) + (out.r[g] ?? 0)).toBeLessThanOrEqual((out.r[p] ?? 0) * 1.0001);
  }
}

/** The worst sibling distance over the two radii's sum, over every module (≥ 1 when no siblings overlap). */
export function worstSeparation(tree: LODTree, out: Pick<Layout, "cx" | "cy" | "r">): number {
  let worst = Infinity;
  for (let g = tree.leafCount; g < tree.size; g++) {
    const c = kids(tree, g);
    for (let a = 0; a < c.length; a++) {
      for (let b = a + 1; b < c.length; b++) {
        const ca = c[a] ?? 0;
        const cb = c[b] ?? 0;
        worst = Math.min(worst, centreDistance(out, ca, cb) / ((out.r[ca] ?? 0) + (out.r[cb] ?? 0)));
      }
    }
  }
  return worst;
}

/** The layout invariants: every child disc inside its parent's, no two sibling discs overlapping. */
export function expectNested(tree: LODTree, out: Layout): void {
  expectContained(tree, out);
  for (let g = tree.leafCount; g < tree.size; g++) {
    const c = kids(tree, g);
    for (let a = 0; a < c.length; a++) {
      for (let b = a + 1; b < c.length; b++) {
        const ca = c[a] ?? 0;
        const cb = c[b] ?? 0;
        expect(centreDistance(out, ca, cb)).toBeGreaterThanOrEqual(((out.r[ca] ?? 0) + (out.r[cb] ?? 0)) * 0.98);
      }
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


/**
 * A synthetic Infomap-like module tree over `leaves` leaves, for timing the nested layout at scale (#333,
 * #355): leaves → bottom modules (mean ~40 children) → mid modules (~15) → top modules (~10) → root, every
 * group size heavy-tailed; about 4 random sibling links per module child with random flows, and a
 * heavy-tailed leaf flow. Seeded, so every run lays out the same tree (at 325,729 leaves: 336,616 tree
 * nodes below the root in 10,888 modules; at 1,000,000: 1,033,396 in 33,397).
 */
export function infomapLikeTree(leaves: number): { topo: NestedLayoutTopology; flow: Float32Array } {
  let seed = 12345;
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const group = (n: number, mean: number): number[] => {
    const sizes: number[] = [];
    for (let left = n; left > 0; ) {
      const s = Math.min(left, Math.max(2, Math.floor((mean / 3) * Math.pow(rnd(), -0.6))));
      sizes.push(s);
      left -= s;
    }
    return sizes;
  };
  const bottom = group(leaves, 40);
  const mid = group(bottom.length, 15);
  const top = group(mid.length, 10);
  const levels = [bottom, mid, top];
  const counts = [leaves, bottom.length, mid.length, top.length, 1];
  const size = counts.reduce((a, b) => a + b, 0);
  const base = [0];
  for (let i = 1; i < counts.length; i++) base.push((base[i - 1] ?? 0) + (counts[i - 1] ?? 0));
  const parent = new Int32Array(size).fill(-1);
  levels.forEach((sizes, lvl) => {
    let c = base[lvl] ?? 0;
    const up = base[lvl + 1] ?? 0;
    sizes.forEach((s, gi) => {
      for (let j = 0; j < s; j++) parent[c++] = up + gi;
    });
  });
  const root = base[4] ?? 0;
  for (let g = base[3] ?? 0; g < root; g++) parent[g] = root;

  const childOffset = new Uint32Array(size + 1);
  for (let g = 0; g < size; g++) {
    const p = parent[g] ?? -1;
    if (p >= 0) childOffset[p + 1] = (childOffset[p + 1] ?? 0) + 1;
  }
  for (let g = 0; g < size; g++) childOffset[g + 1] = (childOffset[g + 1] ?? 0) + (childOffset[g] ?? 0);
  const children = new Uint32Array(childOffset[size] ?? 0);
  const cursor = childOffset.slice(0, size);
  for (let g = 0; g < size; g++) {
    const p = parent[g] ?? -1;
    if (p < 0) continue;
    const at = cursor[p] ?? 0;
    children[at] = g;
    cursor[p] = at + 1;
  }

  const out: number[][] = Array.from({ length: size }, () => []);
  for (let g = 0; g < size; g++) {
    const first = childOffset[g] ?? 0;
    const k = (childOffset[g + 1] ?? 0) - first;
    if (k < 2) continue;
    const m = Math.min(4 * k, (k * (k - 1)) / 2);
    for (let e = 0; e < m; e++) {
      const a = children[first + Math.floor(rnd() * k)] ?? 0;
      const b = children[first + Math.floor(rnd() * k)] ?? 0;
      if (a !== b) out[a]?.push(b);
    }
  }
  const superEdgeOffset = new Uint32Array(size + 1);
  for (let g = 0; g < size; g++) superEdgeOffset[g + 1] = (superEdgeOffset[g] ?? 0) + (out[g]?.length ?? 0);
  const superEdgeTarget = new Uint32Array(superEdgeOffset[size] ?? 0);
  const superEdgeFlow = new Float32Array(superEdgeTarget.length);
  let e = 0;
  for (const targets of out) {
    for (const t of targets) {
      superEdgeTarget[e] = t;
      superEdgeFlow[e++] = rnd();
    }
  }
  const flow = new Float32Array(leaves);
  for (let i = 0; i < leaves; i++) flow[i] = Math.pow(rnd(), -1.5);
  return {
    topo: { size, leafCount: leaves, childOffset, children, parent, superEdgeOffset, superEdgeTarget, superEdgeFlow },
    flow,
  };
}

/**
 * A two-level map with one large module of very uneven child sizes (#380): `big` leaves with Zipf flows
 * (1/rank) in module 1 — radii spanning √big — and `small` modules of 40 leaves with heavy-tailed flows;
 * leaves chained inside each module plus a random link from 30% of them. Seeded. The collision worst case
 * of a single-scale grid: at 60,000 children it took 3.6 billion pair tests per collision step.
 */
export function zipfModuleTree(big: number, small = 200): { topo: NestedLayoutTopology; flow: Float32Array } {
  let seed = 7;
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const n = big + 40 * small;
  const records: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const flow = new Float32Array(n);
  for (let id = 0; id < n; id++) {
    const inBig = id < big;
    const m = inBig ? 0 : 1 + Math.floor((id - big) / 40);
    const rank = inBig ? id : (id - big) % 40;
    records.push({ id, path: [m + 1, rank + 1] });
    flow[id] = inBig ? 1 / (id + 1) : 0.001 * (rnd() + 0.05) ** -1.2;
    if (rank > 0) {
      source.push(id - 1);
      target.push(id);
    }
    if (rnd() < 0.3) {
      source.push(id);
      target.push(Math.floor(rnd() * n));
    }
  }
  return { topo: topo(buildModuleLODTree(n, records, { source, target, weight: new Float32Array(source.length).fill(1) })), flow };
}
