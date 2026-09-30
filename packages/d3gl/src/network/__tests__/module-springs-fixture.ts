/**
 * The module-springs fixture (#455), shared by the node and browser tests. `.ftree`-shaped: `TOPS` top
 * modules, each of two sub-modules of `LEAVES` leaves. The only graph edges are rings inside the bottom
 * modules; every coarser link is a module link — as in an Infomap `.ftree`, whose `*Links` sections are the
 * only record of the links between modules.
 */
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { moduleSpringsOf, type ModuleSprings } from "../module-springs.js";

export const LEAVES = 6;
export const TOPS = 8;

export interface Fixture {
  graph: NetworkGraph;
  records: ModuleNode[];
  /** Leaf ids of top module `t` (1-based). */
  top: (t: number) => number[];
}

export function fixture(): Fixture {
  const records: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  let id = 0;
  for (let t = 1; t <= TOPS; t++) {
    for (let s = 1; s <= 2; s++) {
      const first = id;
      for (let r = 1; r <= LEAVES; r++) records.push({ id: id++, path: [t, s, r] });
      for (let r = 0; r < LEAVES; r++) {
        source.push(first + r);
        target.push(first + ((r + 1) % LEAVES));
      }
    }
  }
  const graph = buildGraph({ nodeCount: id, source, target, weight: source.map(() => 0.01) });
  const top = (t: number): number[] => records.filter((r) => r.path[0] === t).map((r) => r.id);
  return { graph, records, top };
}

/** Modules 1 ↔ 2 linked at the top level, and the two halves of modules 1-3 inside them. No other top
 *  module has a link to another. */
export const LINKS: ModuleLink[] = [
  { source: [1], target: [2], flow: 0.3 },
  { source: [2], target: [1], flow: 0.3 },
  { source: [1, 1], target: [1, 2], flow: 0.05 },
  { source: [2, 1], target: [2, 2], flow: 0.05 },
  { source: [3, 1], target: [3, 2], flow: 0.05 },
];

/** `links` as springs for the fixture's graph. */
export function springsOf(f: Fixture, links: ModuleLink[]): ModuleSprings {
  const tree = buildModuleLODTree(f.graph.nodeCount, f.records, f.graph, links);
  const springs = moduleSpringsOf(tree, f.graph);
  if (!springs) throw new Error("expected module springs");
  return springs;
}

export function centroid(positions: Float32Array, ids: readonly number[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const i of ids) {
    x += positions[i * 2]!;
    y += positions[i * 2 + 1]!;
  }
  return [x / ids.length, y / ids.length];
}
