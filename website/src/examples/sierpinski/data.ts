/**
 * A **directed Sierpinski-gasket map of networks** — a self-similar planted hierarchy to exercise the
 * `network()` map register (flow borders + bent half-arrow super-edges + provided-hierarchy LOD).
 *
 * A recursive 3-ary gasket: each smallest triangle is a dense directed 3-cycle (a community), and
 * sibling sub-gaskets are joined by sparse directed **corner bridges** — the Sierpinski connectivity,
 * but with distinct nodes (no shared corners), so every node has one unambiguous module `path`. The
 * subdivision tree *is* the module hierarchy, emitted in Infomap's JSON `nodes` shape and fed straight
 * to `net.lod({ modules })`.
 *
 * depth D → 3^D leaf triangles → 3^(D+1) nodes, with D module levels (path length D+1).
 */

export interface SierpinskiMap {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
  /** Gasket coordinates [x, y, …]. */
  positions: Float32Array;
  /** Per-node visit rate ∝ weighted degree (sums to 1) — drives node fill/size. */
  flow: Float32Array;
  /** Per-node boundary (enter/exit) flow = incident inter-module bridge weight — drives the border ring. */
  enterExit: Float32Array;
  /** Infomap JSON `nodes`: { id, path } per node — the provided module hierarchy. */
  modules: { id: number; path: number[] }[];
}

type Pt = readonly [number, number];
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

const SCALE = 1000;
const SHRINK = 0.22; // pull leaf nodes off the shared corners so bridges have length
const INTRA = 6; // directed 3-cycle weight inside a leaf triangle (dense community)
const BRIDGE = 1; // directed bridge weight between sibling sub-gaskets (sparse)

/** Generate the directed Sierpinski map at the given `depth` (≥ 1). Deterministic. */
export function generateSierpinskiMap(depth: number): SierpinskiMap {
  const positions: number[] = [];
  const paths: number[][] = [];
  const idByPath = new Map<string, number>();
  const key = (p: number[]): string => p.join(":");

  // Place the 3 leaf nodes of each smallest triangle just inside its corners (toward the centroid).
  const emitLeaf = (prefix: number[], q0: Pt, q1: Pt, q2: Pt): void => {
    const gx = (q0[0] + q1[0] + q2[0]) / 3;
    const gy = (q0[1] + q1[1] + q2[1]) / 3;
    [q0, q1, q2].forEach((c, r) => {
      const id = paths.length;
      const path = [...prefix, r + 1];
      paths.push(path);
      idByPath.set(key(path), id);
      positions.push(c[0] + (gx - c[0]) * SHRINK, c[1] + (gy - c[1]) * SHRINK);
    });
  };
  const subdivide = (prefix: number[], p0: Pt, p1: Pt, p2: Pt): void => {
    if (prefix.length === depth) return emitLeaf(prefix, p0, p1, p2);
    subdivide([...prefix, 1], p0, mid(p0, p1), mid(p0, p2));
    subdivide([...prefix, 2], mid(p0, p1), p1, mid(p1, p2));
    subdivide([...prefix, 3], mid(p0, p2), mid(p1, p2), p2);
  };
  subdivide([], [0, 0], [SCALE, 0], [SCALE / 2, (SCALE * Math.sqrt(3)) / 2]);

  const nodeCount = paths.length;
  // The leaf at corner c (1↔0, 2↔1, 3↔2) of the sub-gasket `prefix`: descend by child c to a leaf, rank c.
  const cornerId = (prefix: number[], c: number): number => {
    const p = [...prefix];
    while (p.length < depth) p.push(c);
    p.push(c);
    return idByPath.get(key(p))!;
  };

  const src: number[] = [];
  const tgt: number[] = [];
  const w: number[] = [];
  const isBridge: boolean[] = [];
  const edge = (a: number, b: number, weight: number, bridge: boolean): void => {
    src.push(a), tgt.push(b), w.push(weight), isBridge.push(bridge);
  };

  // Intra-triangle: a directed 3-cycle 0→1→2→0 per leaf triangle (dense, within-community flow).
  for (let leaf = 0; leaf < nodeCount; leaf += 3) {
    edge(leaf, leaf + 1, INTRA, false);
    edge(leaf + 1, leaf + 2, INTRA, false);
    edge(leaf + 2, leaf, INTRA, false);
  }
  // Corner bridges: at every internal module, join its 3 children at the shared midpoints, directed
  // consistently (child1→child2→child3→child1) so reciprocal arrows separate.
  const addBridges = (prefix: number[]): void => {
    if (prefix.length === depth) return;
    const c1 = [...prefix, 1];
    const c2 = [...prefix, 2];
    const c3 = [...prefix, 3];
    edge(cornerId(c1, 2), cornerId(c2, 1), BRIDGE, true);
    edge(cornerId(c2, 3), cornerId(c3, 2), BRIDGE, true);
    edge(cornerId(c3, 1), cornerId(c1, 3), BRIDGE, true);
    addBridges(c1), addBridges(c2), addBridges(c3);
  };
  addBridges([]);

  // Per-node weighted degree → flow (∝ strength, normalised), and boundary flow from bridges only.
  const strength = new Float64Array(nodeCount);
  const enterExit = new Float32Array(nodeCount);
  let total = 0;
  for (let e = 0; e < src.length; e++) {
    strength[src[e]!] += w[e]!;
    strength[tgt[e]!] += w[e]!;
    total += 2 * w[e]!;
    if (isBridge[e]) {
      enterExit[src[e]!] += w[e]!;
      enterExit[tgt[e]!] += w[e]!;
    }
  }
  const flow = new Float32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) flow[i] = strength[i]! / total;

  return {
    nodeCount,
    source: Uint32Array.from(src),
    target: Uint32Array.from(tgt),
    weight: Float32Array.from(w),
    positions: Float32Array.from(positions),
    flow,
    enterExit,
    modules: paths.map((path, id) => ({ id, path })),
  };
}
