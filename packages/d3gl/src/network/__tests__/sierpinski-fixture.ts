import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";

/**
 * The undirected Sierpinski gasket of the Modular level of detail example (`website/src/examples/modular-lod/data.ts`):
 * each smallest triangle a 3-node module, its siblings joined by corner bridges, the subdivision tree the module
 * hierarchy. Depth `d` → 3^(d+1) nodes. The gasket's self-similarity puts siblings at every level the same
 * distance apart, so one level's glyphs either all clear each other or none do (#561).
 */
export interface Sierpinski {
  graph: NetworkGraph;
  modules: ModuleNode[];
}

type Pt = readonly [number, number];
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const SCALE = 1000;
const HEIGHT = (SCALE * Math.sqrt(3)) / 2;
const SHRINK = 0.22;

export function sierpinski(depth: number): Sierpinski {
  const positions: number[] = [];
  const paths: number[][] = [];
  const idByPath = new Map<string, number>();
  const leaf = (prefix: number[], q0: Pt, q1: Pt, q2: Pt): void => {
    const gx = (q0[0] + q1[0] + q2[0]) / 3;
    const gy = (q0[1] + q1[1] + q2[1]) / 3;
    [q0, q1, q2].forEach((c, r) => {
      idByPath.set([...prefix, r + 1].join(":"), paths.length);
      paths.push([...prefix, r + 1]);
      positions.push(c[0] + (gx - c[0]) * SHRINK, HEIGHT - (c[1] + (gy - c[1]) * SHRINK));
    });
  };
  const subdivide = (prefix: number[], p0: Pt, p1: Pt, p2: Pt): void => {
    if (prefix.length === depth) return leaf(prefix, p0, p1, p2);
    subdivide([...prefix, 1], p0, mid(p0, p1), mid(p0, p2));
    subdivide([...prefix, 2], mid(p0, p1), p1, mid(p1, p2));
    subdivide([...prefix, 3], mid(p0, p2), mid(p1, p2), p2);
  };
  subdivide([], [0, 0], [SCALE, 0], [SCALE / 2, HEIGHT]);
  const corner = (prefix: number[], c: number): number => {
    const p = [...prefix];
    while (p.length <= depth) p.push(c);
    return idByPath.get(p.join(":")) ?? 0;
  };
  const source: number[] = [];
  const target: number[] = [];
  const edge = (a: number, b: number): void => void (source.push(a), target.push(b));
  for (let t = 0; t < paths.length; t += 3) {
    edge(t, t + 1);
    edge(t + 1, t + 2);
    edge(t, t + 2);
  }
  const bridges = (prefix: number[]): void => {
    if (prefix.length === depth) return;
    const c1 = [...prefix, 1];
    const c2 = [...prefix, 2];
    const c3 = [...prefix, 3];
    edge(corner(c1, 2), corner(c2, 1));
    edge(corner(c2, 3), corner(c3, 2));
    edge(corner(c1, 3), corner(c3, 1));
    for (const c of [c1, c2, c3]) bridges(c);
  };
  bridges([]);
  const graph = buildGraph({ nodeCount: paths.length, source: Uint32Array.from(source), target: Uint32Array.from(target) });
  graph.positions.set(positions);
  return { graph, modules: paths.map((path, id) => ({ id, path })) };
}
