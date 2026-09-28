/**
 * The GPU multilevel seed plan (#353, spec §6.4 / §8): a coarsening plan is the CPU `multilevelSeed` level
 * for level; a module plan keeps the #180 depth traversal with each terminal leaf placed once.
 */
import { describe, expect, it } from "vitest";
import { buildHierarchy, coarseLevelMasses, multilevelSeed, seedLevelTicks, type CoarseLevel } from "../../coarsen.js";
import { buildCSR } from "../../graph.js";
import { DEFAULT_FORCE, springStabilizers } from "../../force.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";
import { buildHubChunks } from "../hub-chunks.js";
import {
  canModuleSeed,
  coarseSeedPlan,
  moduleSeedPlan,
  seedPlanCapacity,
  seedPlanTransferables,
  type SeedPlan,
} from "../seed-plan.js";

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** `k` clusters of `m` nodes with mostly intra-cluster edges (so the coarsening groups them), weights 1. */
function clustered(k: number, m: number, perNode: number, seed: number): CoarseLevel {
  const rng = prng(seed);
  const n = k * m;
  const e = n * perNode;
  const source = new Uint32Array(e);
  const target = new Uint32Array(e);
  for (let i = 0; i < e; i++) {
    const a = Math.floor(rng() * n);
    const c = Math.floor(a / m);
    source[i] = a;
    target[i] = rng() < 0.9 ? c * m + Math.floor(rng() * m) : Math.floor(rng() * n);
  }
  return { nodeCount: n, source, target, weight: new Float32Array(e).fill(1) };
}

/** Replays a plan's placements with no solve: each level at its parents' positions plus its offsets. */
function placeWithoutSolves(plan: SeedPlan): { levels: Float32Array[]; nodes: Float32Array } {
  const levels: Float32Array[] = [];
  let above: Float32Array = Float32Array.from(plan.root);
  for (const level of plan.levels) {
    const pos = new Float32Array(level.count * 2);
    for (let i = 0; i < level.count; i++) {
      const p = level.parent[i] ?? 0;
      pos[i * 2] = (above[p * 2] ?? NaN) + (level.offset[i * 2] ?? NaN);
      pos[i * 2 + 1] = (above[p * 2 + 1] ?? NaN) + (level.offset[i * 2 + 1] ?? NaN);
    }
    levels.push(pos);
    above = pos;
  }
  const nodes = new Float32Array(plan.nodeCount * 2).fill(NaN);
  if (plan.finest) {
    for (let i = 0; i < plan.nodeCount; i++) {
      const p = plan.finest.parent[i] ?? 0;
      nodes[i * 2] = (above[p * 2] ?? NaN) + (plan.finest.offset[i * 2] ?? NaN);
      nodes[i * 2 + 1] = (above[p * 2 + 1] ?? NaN) + (plan.finest.offset[i * 2 + 1] ?? NaN);
    }
  } else {
    plan.levels.forEach((level, d) => {
      const pos = levels[d] ?? new Float32Array(0);
      for (let j = 0; j < level.leaves.length; j += 2) {
        const s = level.leaves[j] ?? 0;
        const node = level.leaves[j + 1] ?? 0;
        nodes[node * 2] = pos[s * 2] ?? NaN;
        nodes[node * 2 + 1] = pos[s * 2 + 1] ?? NaN;
      }
    });
  }
  return { levels, nodes };
}

const W = 800;
const H = 600;

describe("coarseSeedPlan — the CPU multilevel seed as GPU levels", () => {
  const graph = clustered(40, 50, 4, 0x5eed);
  const hierarchy = buildHierarchy(graph);
  const plan = coarseSeedPlan(graph, hierarchy, { width: W, height: H });

  it("has one level per coarse hierarchy level, coarsest first, and prolongates the graph's nodes from level 1", () => {
    expect(plan).not.toBeNull();
    if (!plan) return;
    const coarse = hierarchy.levels.slice(1).reverse();
    expect(plan.levels.map((l) => l.count)).toEqual(coarse.map((l) => l.nodeCount));
    expect(plan.finest?.parent.length).toBe(graph.nodeCount);
    expect(Array.from(plan.finest?.parent ?? [])).toEqual(Array.from(hierarchy.projections[0] ?? []));
    // Every level below the top prolongates from the level above through the hierarchy's projection.
    for (let j = 1; j < plan.levels.length; j++) {
      const k = hierarchy.levels.length - 1 - j;
      expect(Array.from(plan.levels[j]?.parent ?? [])).toEqual(Array.from(hierarchy.projections[k] ?? []));
    }
    expect(Array.from(plan.levels[0]?.parent ?? [1])).toEqual(new Array(plan.levels[0]?.count).fill(0));
  });

  it("carries the CPU seed's masses, weighted springs, stabilizers, hub chunks, attraction and tick schedule", () => {
    if (!plan) throw new Error("no plan");
    const masses = coarseLevelMasses(hierarchy);
    const coarseAttraction = DEFAULT_FORCE.attraction; // unit weights: edges / Σweight = 1
    expect(plan.attraction).toBeCloseTo(coarseAttraction, 12);
    const params = { ...DEFAULT_FORCE, attraction: plan.attraction };
    plan.levels.forEach((level, j) => {
      const k = hierarchy.levels.length - 1 - j;
      const edges = hierarchy.levels[k];
      if (!edges) throw new Error("missing level");
      expect(Array.from(level.mass)).toEqual(Array.from(masses[k - 1] ?? []));
      const csr = buildCSR(level.count, edges.source, edges.target, edges.weight);
      expect(Array.from(level.offsets)).toEqual(Array.from(csr.offsets));
      expect(Array.from(level.neighbors)).toEqual(Array.from(csr.neighbors));
      expect(Array.from(level.weights)).toEqual(Array.from(csr.weights ?? []));
      expect(Array.from(level.stab)).toEqual(
        Array.from(springStabilizers(level.count, edges.source, edges.target, edges.source.length, params, level.mass, edges.weight)),
      );
      const hubs = buildHubChunks(csr.offsets);
      expect(level.chunkCount).toBe(hubs.count);
      expect(level.ticks).toBe(seedLevelTicks(level.count, 30, 16384));
      expect(level.leaves.length).toBe(0);
    });
    // Masses add up to the graph at every level.
    for (const level of plan.levels) expect(level.mass.reduce((a, b) => a + b, 0)).toBe(graph.nodeCount);
  });

  it("normalises weighted springs by edges / Σ weight, as the CPU seed does", () => {
    const weighted: CoarseLevel = { ...graph, weight: new Float32Array(graph.source.length).fill(4) };
    const p = coarseSeedPlan(weighted, buildHierarchy(weighted), { width: W, height: H });
    expect(p?.attraction).toBeCloseTo(DEFAULT_FORCE.attraction / 4, 12);
  });

  it("places every level exactly as the CPU seed does, centred on the viewport (no solves: coarsenIterations 0)", () => {
    const noSolve = coarseSeedPlan(graph, hierarchy, { width: W, height: H, coarsenIterations: 0 });
    if (!noSolve) throw new Error("no plan");
    expect(noSolve.levels.every((l) => l.ticks === 0)).toBe(true);
    const cpu = { ...graph, positions: new Float32Array(graph.nodeCount * 2) };
    multilevelSeed(cpu, { width: W, height: H, coarsenIterations: 0 }, hierarchy);
    const { nodes } = placeWithoutSolves(noSolve);
    let maxErr = 0;
    let maxAbs = 0;
    for (let i = 0; i < nodes.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((nodes[i] ?? NaN) - (cpu.positions[i] ?? NaN)));
      maxAbs = Math.max(maxAbs, Math.abs(cpu.positions[i] ?? 0));
    }
    // The CPU adds each offset in float64 before storing; the plan stores the offset first. Float32 rounding.
    expect(maxErr).toBeLessThan(maxAbs * 1e-5);
    // The top level's centre of mass is the viewport centre.
    const top = noSolve.levels[0];
    const topPos = placeWithoutSolves(noSolve).levels[0];
    if (!top || !topPos) throw new Error("no top level");
    let mx = 0;
    let my = 0;
    top.mass.forEach((m, i) => {
      mx += m * (topPos[i * 2] ?? 0);
      my += m * (topPos[i * 2 + 1] ?? 0);
    });
    expect(mx / graph.nodeCount).toBeCloseTo(W / 2, 1);
    expect(my / graph.nodeCount).toBeCloseTo(H / 2, 1);
  });

  it("is null for a graph that cannot be coarsened (edge-less), where the caller seeds a disc", () => {
    const empty: CoarseLevel = { nodeCount: 50, source: new Uint32Array(0), target: new Uint32Array(0), weight: new Float32Array(0) };
    expect(coarseSeedPlan(empty, buildHierarchy(empty), { width: W, height: H })).toBeNull();
  });

  it("transfers: every buffer once, and a structured clone with them leaves the sender's arrays detached", () => {
    if (!plan) throw new Error("no plan");
    const buffers = seedPlanTransferables(plan);
    expect(new Set(buffers).size).toBe(buffers.length);
    const copy = structuredClone(plan, { transfer: buffers });
    expect(copy.levels.length).toBe(plan.levels.length);
    expect(plan.levels[0]?.mass.length).toBe(0); // detached
    expect(copy.finest?.parent.length).toBe(graph.nodeCount);
  });

  it("gives a level placed without a solve (no ticks) no springs, so it adds nothing to the solver's capacity", () => {
    const noSolve = coarseSeedPlan(graph, hierarchy, { width: W, height: H, coarsenIterations: 0 });
    if (!noSolve) throw new Error("no plan");
    expect(noSolve.levels.every((l) => l.neighbors.length === 0 && l.chunkCount === 0)).toBe(true);
    expect(seedPlanCapacity(noSolve).entries).toBe(0);
  });

  it("reports the capacity a solver needs: the most slots, CSR entries, chunks and leaves of any level", () => {
    const p = coarseSeedPlan(graph, hierarchy, { width: W, height: H });
    if (!p) throw new Error("no plan");
    const cap = seedPlanCapacity(p);
    expect(cap.slots).toBe(Math.max(...p.levels.map((l) => l.count)));
    expect(cap.entries).toBe(Math.max(...p.levels.map((l) => l.neighbors.length)));
    expect(cap.chunks).toBe(Math.max(...p.levels.map((l) => l.chunkCount)));
    expect(cap.leaves).toBe(0);
    expect(cap.slots).toBeLessThan(graph.nodeCount);
  });
});

describe("moduleSeedPlan — the module tree by depth (#180)", () => {
  /** Ragged: some modules directly under the root, some one or two levels deeper. */
  function raggedTree(): { graph: CoarseLevel; records: ModuleNode[]; moduleOf: Int32Array } {
    const K = 6;
    const m = 30;
    const n = K * m;
    const rng = prng(0x4a66);
    const src: number[] = [];
    const tgt: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let e = 0; e < 3; e++) {
        src.push(i);
        tgt.push(Math.floor(i / m) * m + Math.floor(rng() * m));
      }
      if (rng() < 0.1) {
        src.push(i);
        tgt.push(Math.floor(rng() * n));
      }
    }
    const moduleOf = new Int32Array(n);
    const rank = new Map<number, number>();
    const prefix = (c: number): number[] => (c % 3 === 0 ? [100 + c] : c % 3 === 1 ? [1, 200 + c] : [2, 300 + c, 400 + c]);
    const records: ModuleNode[] = [];
    for (let i = 0; i < n; i++) {
      const c = Math.floor(i / m);
      moduleOf[i] = c;
      const r = (rank.get(c) ?? 0) + 1;
      rank.set(c, r);
      records.push({ id: i, path: [...prefix(c), r] });
    }
    const graph: CoarseLevel = { nodeCount: n, source: Uint32Array.from(src), target: Uint32Array.from(tgt), weight: new Float32Array(src.length).fill(1) };
    return { graph, records, moduleOf };
  }

  const { graph, records, moduleOf } = raggedTree();
  const tree = buildModuleLODTree(graph.nodeCount, records, graph);
  const plan = moduleSeedPlan(tree, graph, { width: W, height: H });

  it("lists every node as a terminal leaf of exactly one level, and seeds the finest level from those leaves", () => {
    expect(canModuleSeed(tree, graph.nodeCount)).toBe(true);
    if (!plan) throw new Error("no plan");
    expect(plan.finest).toBeNull();
    const seen = new Uint8Array(graph.nodeCount);
    const leafLevels = new Set<number>();
    plan.levels.forEach((level, d) => {
      for (let j = 0; j < level.leaves.length; j += 2) {
        const node = level.leaves[j + 1] ?? 0;
        seen[node] = (seen[node] ?? 0) + 1;
        leafLevels.add(d);
        expect(level.leaves[j]).toBeLessThan(level.count);
      }
    });
    expect(Array.from(seen).every((c) => c === 1)).toBe(true);
    expect(leafLevels.size).toBeGreaterThan(1); // ragged: leaves end at more than one depth
    expect(seedPlanCapacity(plan).leaves).toBeGreaterThan(0);
  });

  it("weighs each slot by the leaves under it, so every level's masses add up to the leaves still below it", () => {
    if (!plan) throw new Error("no plan");
    expect(plan.levels[0]?.mass.reduce((a, b) => a + b, 0)).toBe(graph.nodeCount);
    let placed = 0;
    for (const level of plan.levels) {
      expect(level.mass.reduce((a, b) => a + b, 0)).toBe(graph.nodeCount - placed);
      placed += level.leaves.length / 2;
    }
  });

  it("rings every module's leaves about it, and centres the roots' mass on the viewport", () => {
    if (!plan) throw new Error("no plan");
    const { nodes } = placeWithoutSolves(plan);
    expect(nodes.every((v) => Number.isFinite(v))).toBe(true);
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < graph.nodeCount; i++) {
      cx += nodes[i * 2] ?? 0;
      cy += nodes[i * 2 + 1] ?? 0;
    }
    // With no solve, the leaves' centroid is the roots' centre of mass up to the phyllotaxis discs' residue.
    const spacing = Math.sqrt((Math.PI * DEFAULT_FORCE.repulsion) / DEFAULT_FORCE.centering);
    expect(Math.hypot(cx / graph.nodeCount - W / 2, cy / graph.nodeCount - H / 2)).toBeLessThan(3 * spacing);
    // Same-module leaves sit closer together than leaves of different modules.
    let intra = 0;
    let ni = 0;
    let inter = 0;
    let ne = 0;
    for (let i = 0; i < graph.nodeCount; i += 3) {
      for (let j = i + 1; j < graph.nodeCount; j += 7) {
        const d = Math.hypot((nodes[i * 2] ?? 0) - (nodes[j * 2] ?? 0), (nodes[i * 2 + 1] ?? 0) - (nodes[j * 2 + 1] ?? 0));
        if (moduleOf[i] === moduleOf[j]) {
          intra += d;
          ni++;
        } else {
          inter += d;
          ne++;
        }
      }
    }
    expect(intra / ni / (inter / ne)).toBeLessThan(0.7);
  });

  it("springs join two nodes of one depth only, weighted by their summed edge weights", () => {
    if (!plan) throw new Error("no plan");
    for (const level of plan.levels) {
      for (const j of level.neighbors) expect(j).toBeLessThan(level.count);
      expect(level.weights.every((w) => w > 0)).toBe(true);
    }
    expect(plan.levels.some((l) => l.neighbors.length > 0)).toBe(true);
  });

  it("places a depth of terminal leaves only (the graph's own nodes) without a solve, and gives it no springs", () => {
    const flat = buildModuleLODTree(graph.nodeCount, Array.from(moduleOf, (c, id) => ({ id, path: [c + 1, id + 1] })), graph);
    const p = moduleSeedPlan(flat, graph, { width: W, height: H });
    if (!p) throw new Error("no plan");
    const deepest = p.levels[p.levels.length - 1];
    expect(deepest?.leaves.length).toBe(2 * graph.nodeCount); // every node ends there
    expect(deepest?.ticks).toBe(0);
    expect(deepest?.neighbors.length).toBe(0);
    expect(p.levels.some((l) => l.ticks > 0 && l.neighbors.length > 0)).toBe(true); // the modules are solved
  });

  it("is null without super-edges or depth", () => {
    const flat = buildModuleLODTree(graph.nodeCount, records);
    expect(canModuleSeed(flat, graph.nodeCount)).toBe(false);
    expect(moduleSeedPlan(flat, graph, { width: W, height: H })).toBeNull();
  });
});
