/**
 * Sierpinski-gasket network generator — a planted-hierarchy fixture for the provided-hierarchy LOD
 * (#104 N6 / epic #98).
 *
 * A clean test bed for `lod({ modules })`: a recursive 3-ary gasket where each smallest triangle is a
 * dense 3-node community and sibling sub-gaskets are joined by sparse **corner bridges** — exactly the
 * Sierpinski connectivity, but with *distinct* nodes (no shared corners) so every node belongs to
 * exactly one module path. The subdivision tree *is* the module hierarchy, so we can emit it in
 * Infomap's JSON `nodes` shape and feed it straight back as the LOD source.
 *
 * `depth` D → `3^D` leaf triangles → `3^(D+1)` nodes, with **D module levels** (path length `D+1`).
 */

/** A node in Infomap's JSON output shape (`{ nodes: [...] }`). */
export interface InfomapNode {
  id: number;
  /** 1-based child-index chain root→node (Infomap `path`); the enclosing module is `path.slice(0,-1)`. */
  path: number[];
  /** Visit rate ∝ weighted degree, normalised to sum 1 (a plausible undirected stationary flow). */
  flow: number;
  name: string;
  /** Breadth-first module index per level (Infomap `modules`); length D. */
  modules: number[];
}

export interface SierpinskiNetwork {
  /** Subdivision depth (number of module levels). */
  depth: number;
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
  /** Interleaved gasket coordinates `[x, y, …]`, length `2·nodeCount`. */
  positions: Float32Array;
  /** The planted hierarchy in Infomap's JSON output shape. */
  infomap: { nodes: InfomapNode[] };
}

type Pt = readonly [number, number];
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Master-triangle size and how far each leaf node is pulled off its cell corner toward the centroid. */
const SCALE = 1000;
const SHRINK = 0.2; // keep nodes off the shared corners so bridges have nonzero length
const INTRA_WEIGHT = 10; // dense within a leaf triangle
const BRIDGE_WEIGHT = 1; // sparse between sibling sub-gaskets

/**
 * Generate a Sierpinski-gasket network of the given `depth` (≥ 1) together with its planted module
 * hierarchy. Deterministic — no RNG — so it doubles as a regression fixture.
 */
export function generateSierpinski(depth: number): SierpinskiNetwork {
  if (!Number.isInteger(depth) || depth < 1) throw new Error(`generateSierpinski: depth must be an integer ≥ 1, got ${depth}`);

  const positionsArr: number[] = [];
  const pathById: number[][] = [];
  // Map a node's full path (joined key) → id, so corner-bridge endpoints can be looked up by path.
  const idByPath = new Map<string, number>();
  const key = (p: number[]): string => p.join(":");

  // DFS the subdivision tree, assigning ids in emission order and placing the 3 leaf nodes of each
  // smallest triangle just inside its corners (toward the centroid).
  const emitLeaf = (prefix: number[], q0: Pt, q1: Pt, q2: Pt): void => {
    const gx = (q0[0] + q1[0] + q2[0]) / 3;
    const gy = (q0[1] + q1[1] + q2[1]) / 3;
    const corners: Pt[] = [q0, q1, q2];
    for (let r = 0; r < 3; r++) {
      const c = corners[r]!;
      const id = pathById.length;
      const path = [...prefix, r + 1]; // rank is 1-based; rank r+1 sits at corner index r
      pathById.push(path);
      idByPath.set(key(path), id);
      positionsArr.push(c[0] + (gx - c[0]) * SHRINK, c[1] + (gy - c[1]) * SHRINK);
    }
  };
  const subdivide = (prefix: number[], p0: Pt, p1: Pt, p2: Pt): void => {
    if (prefix.length === depth) {
      emitLeaf(prefix, p0, p1, p2);
      return;
    }
    const m01 = mid(p0, p1);
    const m12 = mid(p1, p2);
    const m02 = mid(p0, p2);
    subdivide([...prefix, 1], p0, m01, m02); // child 1 keeps corner p0 (index 0)
    subdivide([...prefix, 2], m01, p1, m12); // child 2 keeps corner p1 (index 1)
    subdivide([...prefix, 3], m02, m12, p2); // child 3 keeps corner p2 (index 2)
  };

  const A: Pt = [0, 0];
  const B: Pt = [SCALE, 0];
  const C: Pt = [SCALE / 2, (SCALE * Math.sqrt(3)) / 2];
  subdivide([], A, B, C);

  const nodeCount = pathById.length;

  // The leaf node sitting at corner `c` (1↔index0, 2↔index1, 3↔index2) of the sub-gasket rooted at
  // `prefix`: descend choosing child `c` down to a leaf, then take rank `c`.
  const cornerId = (prefix: number[], c: number): number => {
    const path = [...prefix];
    while (path.length < depth) path.push(c);
    path.push(c);
    return idByPath.get(key(path))!;
  };

  const src: number[] = [];
  const tgt: number[] = [];
  const w: number[] = [];
  const edge = (a: number, b: number, weight: number): void => {
    src.push(a);
    tgt.push(b);
    w.push(weight);
  };

  // Intra-triangle edges: the 3 leaf nodes of each smallest triangle form a clique.
  for (let leaf = 0; leaf < nodeCount; leaf += 3) edge(leaf, leaf + 1, INTRA_WEIGHT), edge(leaf + 1, leaf + 2, INTRA_WEIGHT), edge(leaf, leaf + 2, INTRA_WEIGHT);

  // Corner bridges: at every internal module, join its 3 children at the 3 shared midpoints (the
  // Sierpinski "touch points"), connecting the corner-representative leaf of each adjacent pair.
  const addBridges = (prefix: number[]): void => {
    if (prefix.length === depth) return;
    const c1 = [...prefix, 1];
    const c2 = [...prefix, 2];
    const c3 = [...prefix, 3];
    edge(cornerId(c1, 2), cornerId(c2, 1), BRIDGE_WEIGHT); // child1↔child2 at mid(p0,p1)
    edge(cornerId(c2, 3), cornerId(c3, 2), BRIDGE_WEIGHT); // child2↔child3 at mid(p1,p2)
    edge(cornerId(c1, 3), cornerId(c3, 1), BRIDGE_WEIGHT); // child1↔child3 at mid(p0,p2)
    addBridges(c1);
    addBridges(c2);
    addBridges(c3);
  };
  addBridges([]);

  // Weighted degree → flow ∝ strength, normalised to sum 1 (undirected stationary distribution).
  const strength = new Float64Array(nodeCount);
  let total = 0;
  for (let e = 0; e < src.length; e++) {
    const s = src[e]!;
    const t = tgt[e]!;
    strength[s] = strength[s]! + w[e]!;
    strength[t] = strength[t]! + w[e]!;
    total += 2 * w[e]!;
  }

  // Breadth-first module index per level, from the path's module prefix (a base-3 numbering of the
  // complete 3-ary module tree). modules[d-1] addresses the ancestor module at depth d.
  const bfModules = (path: number[]): number[] => {
    const mods: number[] = [];
    let acc = 0;
    for (let d = 0; d < depth; d++) {
      acc = acc * 3 + (path[d]! - 1);
      mods.push(acc + 1);
    }
    return mods;
  };

  const nodes: InfomapNode[] = pathById.map((path, id) => ({
    id,
    path,
    flow: strength[id]! / total,
    name: String(id),
    modules: bfModules(path),
  }));

  return {
    depth,
    nodeCount,
    source: Uint32Array.from(src),
    target: Uint32Array.from(tgt),
    weight: Float32Array.from(w),
    positions: Float32Array.from(positionsArr),
    infomap: { nodes },
  };
}
