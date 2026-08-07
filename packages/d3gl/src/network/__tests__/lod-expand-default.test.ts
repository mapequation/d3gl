import { describe, expect, it } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildLODTree, buildSpatialLODTree, computeLODGeometry, cut, defaultExpandPx, type LODTransform, type LODTree } from "../lod.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import { multilevelLayout } from "../coarsen.js";
import { fitNodes, fitBox, fitTransform } from "../fit.js";

/**
 * #191 — the **adaptive default** expand threshold, pinned by frontier composition at the view the
 * engine actually opens on (`fit`).
 *
 * The bug: `expandPx` is an absolute on-screen size, but the footprint it is compared against scales
 * with how many leaves the *finest* aggregate holds — 2 for a coarsening tree, 30-60 for a provided
 * module partition. The fixed 48 px default therefore did real work on the first and *nothing* on the
 * second: `lod({ modules })` opened on 100 % raw leaves (asserted below as the pre-fix baseline, so
 * this test fails without the fix), which is why both website examples hard-coded `expandPx: 240`.
 */

const W = 820;
const H = 560;

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A deterministic planted partition: ragged community sizes, dense inside, sparse between. */
function plantedPartition(nodeCount: number): { graph: NetworkGraph; modules: ModuleNode[] } {
  const rng = mulberry32(1337);
  const SIZES = [24, 36, 48, 60, 96]; // ragged, like a real partition
  const community = new Int32Array(nodeCount);
  const modules: ModuleNode[] = [];
  let id = 0;
  let c = 0;
  while (id < nodeCount) {
    const size = Math.min(SIZES[c % SIZES.length] ?? 48, nodeCount - id);
    for (let r = 0; r < size; r++) {
      community[id] = c;
      modules.push({ id, path: [c + 1, r + 1] }); // Infomap shape: [module, rank within it]
      id++;
    }
    c++;
  }
  const members: number[][] = Array.from({ length: c }, () => []);
  for (let i = 0; i < nodeCount; i++) members[community[i] ?? 0]?.push(i);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const peers = members[community[i] ?? 0] ?? [];
    for (let e = 0; e < 8; e++) {
      const j = peers[Math.floor(rng() * peers.length)] ?? i;
      if (j !== i) {
        source.push(i);
        target.push(j);
      }
    }
    if (rng() < 0.06) {
      const j = Math.floor(rng() * nodeCount);
      if (j !== i) {
        source.push(i);
        target.push(j);
      }
    }
  }
  const graph = buildGraph({
    nodeCount,
    source: Uint32Array.from(source),
    target: Uint32Array.from(target),
    weight: new Float32Array(source.length).fill(1),
  });
  multilevelLayout(graph, { width: W, height: H, iterations: 300 });
  return { graph, modules };
}

function withGeometry(tree: LODTree, graph: NetworkGraph): LODTree {
  computeLODGeometry(tree, graph, new Float32Array(graph.nodeCount).fill(4));
  return tree;
}

/** The transform `layout({ fit: true })` produces — the view a reader actually opens on. */
function fitView(tree: LODTree): LODTransform {
  const nodes = fitNodes(tree);
  const box = fitBox(tree, nodes, new Float32Array(nodes.length));
  if (!box) throw new Error("no fit box");
  return fitTransform(box, W, H);
}

/** Frontier composition: how many glyphs, and how many of them are raw leaves. */
function composition(tree: LODTree, t: LODTransform, expandPx?: number): { glyphs: number; leaves: number; leafPct: number } {
  const frontier = cut(tree, t, W, H, expandPx === undefined ? {} : { expandPx });
  let leaves = 0;
  for (let i = 0; i < frontier.length; i++) if ((frontier[i] ?? 0) < tree.leafCount) leaves++;
  return { glyphs: frontier.length, leaves, leafPct: (100 * leaves) / frontier.length };
}

describe("adaptive default expandPx (#191)", () => {
  for (const nodeCount of [600, 5000]) {
    describe(`N=${nodeCount}`, () => {
      const { graph, modules } = plantedPartition(nodeCount);

      it("a provided-module tree opens on a map of modules — no raw leaves at the fit view", () => {
        const tree = withGeometry(buildModuleLODTree(nodeCount, modules, graph), graph);
        const t = fitView(tree);

        // Pre-fix baseline: the old fixed 48 px default expanded essentially every module into its
        // members (measured: 99.8 % raw leaves at N=600, 95.3 % at N=5000).
        expect(composition(tree, t, 48).leafPct).toBeGreaterThan(90);

        // With the adaptive default the same view is all aggregates, and a small number of them.
        const withDefault = composition(tree, t);
        expect(withDefault.leaves).toBe(0);
        expect(withDefault.glyphs).toBeLessThan(nodeCount / 10);

        // The threshold it picks: driven by the partition's branching, clamped to half the viewport.
        expect(tree.leafBranching).toBeGreaterThanOrEqual(24);
        const px = defaultExpandPx(tree, W, H);
        expect(px).toBeGreaterThan(150);
        expect(px).toBeLessThanOrEqual(0.5 * Math.min(W, H));
      });

      it("a structural coarsening tree is left byte-for-byte as it was calibrated", () => {
        const tree = withGeometry(buildLODTree(graph, {}), graph);
        const t = fitView(tree);

        expect(tree.leafBranching).toBe(2); // heavy-edge matching pairs nodes
        expect(defaultExpandPx(tree, W, H)).toBe(48);

        // Identical frontier, node for node, to the old fixed default.
        expect(Array.from(cut(tree, t, W, H, {}))).toEqual(Array.from(cut(tree, t, W, H, { expandPx: 48 })));

        // …and that frontier still does real LOD work: a mostly-aggregated view, far fewer glyphs
        // than nodes (the calibration #191 measured — 22-34 % raw leaves on the website's LFR map).
        const withDefault = composition(tree, t);
        expect(withDefault.leafPct).toBeLessThan(45);
        expect(withDefault.glyphs).toBeLessThan(nodeCount / 2);
      });

      it("a spatial quadtree keeps the 48 px default (its bottom cells hold one point)", () => {
        const tree = withGeometry(buildSpatialLODTree(graph.positions, nodeCount, {}), graph);
        const t = fitView(tree);
        expect(tree.leafBranching).toBeLessThanOrEqual(2);
        expect(defaultExpandPx(tree, W, H)).toBe(48);
        expect(Array.from(cut(tree, t, W, H, {}))).toEqual(Array.from(cut(tree, t, W, H, { expandPx: 48 })));
      });
    });
  }

  it("clamps: never below the historical 48 px, never past half the viewport", () => {
    const { graph, modules } = plantedPartition(600);
    const tree = withGeometry(buildModuleLODTree(600, modules, graph), graph);
    // Big modules want a coarse threshold, but a small viewport caps it — a 200x200 view can't be
    // asked to collapse everything into one blob.
    expect(defaultExpandPx(tree, 200, 200)).toBe(100);
    // …and the cap never drags the default *below* the historical one.
    expect(defaultExpandPx(tree, 60, 60)).toBe(48);
    // An explicit value always wins, with its meaning unchanged (48 px ⇒ the pre-fix all-leaves view).
    const t = fitView(tree);
    expect(composition(tree, t, 48).leafPct).toBeGreaterThan(90);
  });
});
