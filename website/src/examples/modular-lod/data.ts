/**
 * An **undirected Sierpinski gasket** with a planted module hierarchy — a clean test bed for
 * **modular-aware LOD**: nodes aggregate into their parent module as you zoom out, and a module's
 * glyph (and all its leaves) share one categorical colour.
 *
 * A recursive 3-ary gasket: each smallest triangle is a 3-node community joined to its siblings by
 * sparse corner bridges, with distinct nodes (no shared corners), so every node has one unambiguous
 * module `path`. The subdivision tree *is* the module hierarchy, emitted in Infomap's JSON `nodes`
 * shape and fed to `net.lod({ modules })`. depth D → 3^D leaf triangles → 3^(D+1) nodes.
 */

export interface SierpinskiGraph {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
  /** Gasket coordinates [x, y, …], apex up. */
  positions: Float32Array;
  /** Infomap JSON `nodes`: { id, path } per node — the provided module hierarchy. `path[0]` is the top module. */
  modules: { id: number; path: number[] }[];
}

type Pt = readonly [number, number];
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

const SCALE = 1000;
const HEIGHT = (SCALE * Math.sqrt(3)) / 2;
const SHRINK = 0.22; // pull leaf nodes off the shared corners so bridges have length
const INTRA = 6; // within a leaf triangle (dense community)
const BRIDGE = 1; // between sibling sub-gaskets (sparse)

/** Generate the undirected Sierpinski gasket at the given `depth` (≥ 1). Deterministic. */
export function generateSierpinski(depth: number): SierpinskiGraph {
  const positions: number[] = [];
  const paths: number[][] = [];
  const idByPath = new Map<string, number>();
  const key = (p: number[]): string => p.join(":");

  const emitLeaf = (prefix: number[], q0: Pt, q1: Pt, q2: Pt): void => {
    const gx = (q0[0] + q1[0] + q2[0]) / 3;
    const gy = (q0[1] + q1[1] + q2[1]) / 3;
    [q0, q1, q2].forEach((c, r) => {
      const id = paths.length;
      paths.push([...prefix, r + 1]);
      idByPath.set(key(paths[id]!), id);
      // Apex-up: flip y within the gasket height.
      positions.push(c[0] + (gx - c[0]) * SHRINK, HEIGHT - (c[1] + (gy - c[1]) * SHRINK));
    });
  };
  const subdivide = (prefix: number[], p0: Pt, p1: Pt, p2: Pt): void => {
    if (prefix.length === depth) return emitLeaf(prefix, p0, p1, p2);
    subdivide([...prefix, 1], p0, mid(p0, p1), mid(p0, p2));
    subdivide([...prefix, 2], mid(p0, p1), p1, mid(p1, p2));
    subdivide([...prefix, 3], mid(p0, p2), mid(p1, p2), p2);
  };
  subdivide([], [0, 0], [SCALE, 0], [SCALE / 2, HEIGHT]);

  const nodeCount = paths.length;
  const cornerId = (prefix: number[], c: number): number => {
    const p = [...prefix];
    while (p.length < depth) p.push(c);
    p.push(c);
    return idByPath.get(key(p))!;
  };

  const src: number[] = [];
  const tgt: number[] = [];
  const w: number[] = [];
  const edge = (a: number, b: number, weight: number): void => void (src.push(a), tgt.push(b), w.push(weight));

  for (let leaf = 0; leaf < nodeCount; leaf += 3) {
    edge(leaf, leaf + 1, INTRA);
    edge(leaf + 1, leaf + 2, INTRA);
    edge(leaf, leaf + 2, INTRA);
  }
  const addBridges = (prefix: number[]): void => {
    if (prefix.length === depth) return;
    const c1 = [...prefix, 1];
    const c2 = [...prefix, 2];
    const c3 = [...prefix, 3];
    // Heavier bridges between larger sub-gaskets, so a super-edge grows as its modules aggregate.
    const w = BRIDGE * Math.pow(3, depth - 1 - prefix.length);
    edge(cornerId(c1, 2), cornerId(c2, 1), w);
    edge(cornerId(c2, 3), cornerId(c3, 2), w);
    edge(cornerId(c1, 3), cornerId(c3, 1), w);
    addBridges(c1), addBridges(c2), addBridges(c3);
  };
  addBridges([]);

  return {
    nodeCount,
    source: Uint32Array.from(src),
    target: Uint32Array.from(tgt),
    weight: Float32Array.from(w),
    positions: Float32Array.from(positions),
    modules: paths.map((path, id) => ({ id, path })),
  };
}

/** The gasket's fixed world bounds (depth-independent) — for fitting the initial view. */
export const SIERPINSKI_BOUNDS = { minX: 0, maxX: SCALE, minY: 0, maxY: HEIGHT };
