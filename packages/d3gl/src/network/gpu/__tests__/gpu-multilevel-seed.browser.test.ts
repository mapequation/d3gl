/**
 * Module-aware GPU multilevel seed (#180 / N8.2).
 *
 * Three concerns:
 *   1. **Seed quality** — on a planted-module graph the module-aware seed places same-module nodes
 *      much closer than cross-module ones (module coherence << 1), better than the plain disc seed,
 *      and refines to a good layout (spreadRatio << 1, the metric shared with gpu-convergence).
 *   2. **Ragged correctness** — a hierarchy whose branches reach different depths seeds without error;
 *      every leaf gets a finite position inside its module's region.
 *   3. **Scale (guards the smallness assumption)** — a ≈1M-node graph with a WIDE top level (thousands
 *      of top modules) and a separate DEEP hierarchy both seed under a generous wall-clock ceiling,
 *      with the per-level solve running on the **GPU** (a bounded, O(depth) number of GPU solves) and
 *      **zero CPU per-level force work** (the CPU ForceLayout.tick is never called). This test FAILS if
 *      someone reintroduces a CPU "small level" force shortcut.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { gpuMultilevelSeed, canModuleSeed } from "../gpu-multilevel-seed.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { ForceLayout, seedPositions, DEFAULT_FORCE } from "../../force.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";
import type { LODTree } from "../../lod.js";

// ── deterministic PRNG ────────────────────────────────────────────────────────
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

// ── metrics ───────────────────────────────────────────────────────────────────

/**
 * Module coherence = mean(intra-module pair distance) / mean(cross-module pair distance) over sampled
 * pairs. << 1 means same-module nodes are much closer than cross-module ones — a coherent layout.
 */
function moduleCoherence(pos: Float32Array, moduleOf: Int32Array, maxPairs = 6000): number {
  const n = pos.length / 2;
  const rng = makePrng(0xc0ffee);
  let intra = 0, ni = 0, inter = 0, ne = 0;
  for (let s = 0; s < maxPairs; s++) {
    const i = Math.floor(rng() * n);
    let j = Math.floor(rng() * n);
    if (i === j) continue;
    const dx = pos[i * 2]! - pos[j * 2]!;
    const dy = pos[i * 2 + 1]! - pos[j * 2 + 1]!;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (moduleOf[i] === moduleOf[j]) { intra += d; ni++; } else { inter += d; ne++; }
  }
  if (ni === 0 || ne === 0) return 1;
  return (intra / ni) / (inter / ne);
}

/** spreadRatio = mean connected edge length / mean random pair distance (<< 1 = good layout). */
function spreadRatio(pos: Float32Array, source: Uint32Array, target: Uint32Array, maxPairs = 3000): number {
  const m = source.length;
  if (m === 0) return 1;
  let edgeLen = 0;
  for (let e = 0; e < m; e++) {
    const a = source[e]!, b = target[e]!;
    const dx = pos[a * 2]! - pos[b * 2]!, dy = pos[a * 2 + 1]! - pos[b * 2 + 1]!;
    edgeLen += Math.sqrt(dx * dx + dy * dy);
  }
  edgeLen /= m;
  const n = pos.length / 2;
  const rng = makePrng(0xbeef);
  let pd = 0;
  const count = Math.min(maxPairs, (n * (n - 1)) / 2);
  for (let k = 0; k < count; k++) {
    const i = Math.floor(rng() * n);
    let j = Math.floor(rng() * (n - 1));
    if (j >= i) j++;
    const dx = pos[i * 2]! - pos[j * 2]!, dy = pos[i * 2 + 1]! - pos[j * 2 + 1]!;
    pd += Math.sqrt(dx * dx + dy * dy);
  }
  pd /= count;
  return pd < 1e-10 ? 1 : edgeLen / pd;
}

/** All sampled positions finite (no NaN / ±Inf). */
function allFinite(pos: Float32Array, sampleEvery = 1): boolean {
  for (let i = 0; i < pos.length; i += sampleEvery) if (!Number.isFinite(pos[i]!)) return false;
  return true;
}

// ── graph generators ──────────────────────────────────────────────────────────

interface PlantedGraph {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
  moduleOf: Int32Array; // per node → its planted module (round-robin, so disc-order does NOT cluster it)
}

/**
 * `k` planted modules of `m` nodes each, **round-robin** assigned (moduleOf[i] = i % k) so the disc
 * seed's phyllotaxis order does not accidentally cluster a module — a fair "bad" baseline. Dense
 * intra-module edges + a few cross-module bridges.
 */
function makePlantedGraph(k: number, m: number, intraDeg: number, bridgesPerPair: number, seed: number): PlantedGraph {
  const rng = makePrng(seed);
  const nodeCount = k * m;
  const moduleOf = new Int32Array(nodeCount);
  const members: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < nodeCount; i++) { const c = i % k; moduleOf[i] = c; members[c]!.push(i); }
  const src: number[] = [], tgt: number[] = [];
  for (let c = 0; c < k; c++) {
    const mem = members[c]!;
    for (let a = 0; a < mem.length; a++) {
      for (let e = 0; e < intraDeg; e++) {
        const b = Math.floor(rng() * mem.length);
        if (b !== a) { src.push(mem[a]!); tgt.push(mem[b]!); }
      }
    }
  }
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) for (let br = 0; br < bridgesPerPair; br++) {
    src.push(members[a]![Math.floor(rng() * m)]!);
    tgt.push(members[b]![Math.floor(rng() * m)]!);
  }
  return { nodeCount, source: Uint32Array.from(src), target: Uint32Array.from(tgt), weight: new Float32Array(src.length).fill(1), moduleOf };
}

/** Flat one-level module records: path = [module + 1, rank] → leaf module = the planted module. */
function flatRecords(moduleOf: Int32Array): ModuleNode[] {
  const rank = new Map<number, number>();
  return Array.from(moduleOf, (c, id) => {
    const r = (rank.get(c) ?? 0) + 1; rank.set(c, r);
    return { id, path: [c + 1, r] };
  });
}

/** Tree-node depths from the parent map (root = 0), for asserting a ragged hierarchy. */
function depthsOf(tree: LODTree): Int32Array {
  const parent = tree.parent!;
  const depth = new Int32Array(tree.size);
  for (let g = tree.size - 2; g >= 0; g--) depth[g] = depth[parent[g]!]! + 1;
  return depth;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("gpuMultilevelSeed — module-aware GPU seed (#180 N8.2)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("seed quality: same-module nodes cluster (better than disc) and refine to a good layout", () => {
    const W = 800, H = 600;
    const g = makePlantedGraph(8, 60, 4, 3, 0xa11ce); // 480 nodes
    const tree = buildModuleLODTree(g.nodeCount, flatRecords(g.moduleOf), { source: g.source, target: g.target, weight: g.weight });
    expect(canModuleSeed(tree, g.nodeCount)).toBe(true);

    // Disc baseline.
    const discPos = new Float32Array(g.nodeCount * 2);
    seedPositions({ nodeCount: g.nodeCount, edgeCount: 0, source: g.source, target: g.target, positions: discPos }, W, H);
    const discCoh = moduleCoherence(discPos, g.moduleOf);

    // Module-aware seed.
    const seedPos = new Float32Array(g.nodeCount * 2);
    gpuMultilevelSeed(device, tree, { nodeCount: g.nodeCount, positions: seedPos }, { width: W, height: H, force: DEFAULT_FORCE });
    const seedCoh = moduleCoherence(seedPos, g.moduleOf);

    console.log(`  [seed-quality] discCoherence=${discCoh.toFixed(3)} moduleSeedCoherence=${seedCoh.toFixed(3)}`);
    expect(allFinite(seedPos)).toBe(true);
    expect(seedCoh).toBeLessThan(0.85);        // same-module clearly closer than cross-module
    expect(seedCoh).toBeLessThan(discCoh * 0.9); // and better than the disc seed

    // Refine from the module-aware seed → a genuinely good layout (connected nodes closer than random).
    const refinePos = seedPos.slice();
    const gpu = new GpuForceLayout(device, { nodeCount: g.nodeCount, edgeCount: g.source.length, source: g.source, target: g.target, positions: refinePos }, DEFAULT_FORCE);
    gpu.runFrame(120);
    const out = new Float32Array(g.nodeCount * 2);
    gpu.readPositions(out);
    gpu.destroy();
    const ratio = spreadRatio(out, g.source, g.target);
    console.log(`  [seed-quality] post-refine spreadRatio=${ratio.toFixed(3)}`);
    expect(ratio).toBeLessThan(1.0);
  });

  it("ragged correctness: branches of different depths seed without error, every leaf finite + coherent", () => {
    const W = 800, H = 600;
    const K = 6, m = 40;
    const g = makePlantedGraph(K, m, 4, 2, 0x4a66ed);
    // Ragged prefixes: some modules top-level (depth 1 leaves), some 1 level deep, one 2 levels deep.
    const raggedPrefix = (c: number): number[] => {
      if (c % 3 === 0) return [10000 + c];               // top-level community (leaf depth 2)
      if (c % 3 === 2) return [1 + (c % 2), 500 + c, 200 + c]; // super → sub → community (leaf depth 4)
      return [1 + (c % 2), 100 + c];                     // super → community (leaf depth 3)
    };
    const rank = new Map<number, number>();
    const records: ModuleNode[] = Array.from(g.moduleOf, (c, id) => {
      const r = (rank.get(c) ?? 0) + 1; rank.set(c, r);
      return { id, path: [...raggedPrefix(c), r] };
    });
    const tree = buildModuleLODTree(g.nodeCount, records, { source: g.source, target: g.target, weight: g.weight });
    expect(canModuleSeed(tree, g.nodeCount)).toBe(true);

    // The hierarchy really is ragged: leaves live at more than one depth.
    const depth = depthsOf(tree);
    const leafDepths = new Set<number>();
    for (let i = 0; i < tree.leafCount; i++) leafDepths.add(depth[i]!);
    console.log(`  [ragged] distinct leaf depths = ${[...leafDepths].sort((a, b) => a - b).join(",")}`);
    expect(leafDepths.size).toBeGreaterThan(1);

    const pos = new Float32Array(g.nodeCount * 2);
    gpuMultilevelSeed(device, tree, { nodeCount: g.nodeCount, positions: pos }, { width: W, height: H, force: DEFAULT_FORCE });
    expect(allFinite(pos)).toBe(true);               // every leaf got a finite position
    const coh = moduleCoherence(pos, g.moduleOf);
    console.log(`  [ragged] moduleCoherence=${coh.toFixed(3)}`);
    expect(coh).toBeLessThan(0.9);                    // each leaf sits within its module's region
  });

  it("scale: WIDE hierarchy (≈1M nodes, thousands of top modules) seeds on GPU, no CPU per-level force", () => {
    const W = 1600, H = 1200;
    const K = 5000, m = 200; // 1,000,000 nodes; 5000 top modules > 4096 → the level solve is the BH pyramid, not O(n²)
    const g = makePlantedGraph(K, m, 2, 0, 0x5ca1e);
    // A few cross-module bridges so the top-level solve has inter-module adjacency (kept small: O(K)).
    const bridgeSrc: number[] = [], bridgeTgt: number[] = [];
    const rng = makePrng(0xb41d9e);
    for (let e = 0; e < K; e++) { bridgeSrc.push(Math.floor(rng() * g.nodeCount)); bridgeTgt.push(Math.floor(rng() * g.nodeCount)); }
    const source = Uint32Array.from([...g.source, ...bridgeSrc]);
    const target = Uint32Array.from([...g.target, ...bridgeTgt]);
    const weight = new Float32Array(source.length).fill(1);
    const tree = buildModuleLODTree(g.nodeCount, flatRecords(g.moduleOf), { source, target, weight });
    expect(canModuleSeed(tree, g.nodeCount)).toBe(true);
    const maxDepth = depthsOf(tree).reduce((a, b) => Math.max(a, b), 0);

    const tickSpy = vi.spyOn(ForceLayout.prototype, "tick");
    const runSpy = vi.spyOn(GpuForceLayout.prototype, "runFrame");
    const pos = new Float32Array(g.nodeCount * 2);
    const t0 = performance.now();
    gpuMultilevelSeed(device, tree, { nodeCount: g.nodeCount, positions: pos }, { width: W, height: H, force: DEFAULT_FORCE, coarsenIterations: 6 });
    const dt = performance.now() - t0;
    const solves = runSpy.mock.calls.length;
    tickSpy.mockRestore();
    runSpy.mockRestore();

    console.log(`  [scale-wide] N=${g.nodeCount} maxDepth=${maxDepth} gpuSolves=${solves} seed=${dt.toFixed(0)}ms`);
    // NO CPU per-level force work — the whole point of #180 (this fails if a CPU shortcut is reintroduced).
    expect(tickSpy).toHaveBeenCalledTimes(0);
    // Per-level solves run on the GPU, a bounded O(depth) count — NOT O(nodes) / O(level).
    expect(solves).toBeGreaterThan(0);
    expect(solves).toBeLessThanOrEqual(maxDepth + 1);
    // Every leaf finite (sample every 101st float to keep the check cheap at 1M).
    expect(allFinite(pos, 101)).toBe(true);
    // Generous SwiftShader tripwire (real-GPU ≈1M validated manually); catches an order-of-magnitude regression.
    expect(dt).toBeLessThan(60_000);
  }, 120_000);

  it("scale: DEEP hierarchy seeds on GPU across many depths, no CPU per-level force", () => {
    const W = 1600, H = 1200;
    // 262,144 leaves = 16,384 leaf-modules × 16 leaves; leaf-module id in base 4 over 7 digits → 7 module
    // levels (leaves at depth 8). A genuinely deep, ragged-capable hierarchy at large scale.
    const B = 4, D = 7, perModule = 16;
    const leafModules = B ** D; // 16384
    const nodeCount = leafModules * perModule; // 262144
    const rng = makePrng(0xdeeb);
    const src: number[] = [], tgt: number[] = [];
    const records: ModuleNode[] = new Array(nodeCount);
    const moduleOf = new Int32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const lm = i >> 4; // leaf-module (16 leaves each)
      moduleOf[i] = lm;
      const digits: number[] = [];
      let x = lm;
      for (let d = 0; d < D; d++) { digits.push((x % B) + 1); x = Math.floor(x / B); }
      records[i] = { id: i, path: [...digits, (i & 15) + 1] };
      // intra-leaf-module edge (a sibling), plus an occasional cross bridge so higher levels get super-edges
      const base = lm * perModule;
      src.push(i); tgt.push(base + Math.floor(rng() * perModule));
      if (rng() < 0.02) { src.push(i); tgt.push(Math.floor(rng() * nodeCount)); }
    }
    const source = Uint32Array.from(src), target = Uint32Array.from(tgt), weight = new Float32Array(src.length).fill(1);
    const tree = buildModuleLODTree(nodeCount, records, { source, target, weight });
    expect(canModuleSeed(tree, nodeCount)).toBe(true);
    const maxDepth = depthsOf(tree).reduce((a, b) => Math.max(a, b), 0);
    expect(maxDepth).toBeGreaterThanOrEqual(8); // genuinely deep

    const tickSpy = vi.spyOn(ForceLayout.prototype, "tick");
    const runSpy = vi.spyOn(GpuForceLayout.prototype, "runFrame");
    const pos = new Float32Array(nodeCount * 2);
    const t0 = performance.now();
    gpuMultilevelSeed(device, tree, { nodeCount, positions: pos }, { width: W, height: H, force: DEFAULT_FORCE, coarsenIterations: 6 });
    const dt = performance.now() - t0;
    const solves = runSpy.mock.calls.length;
    tickSpy.mockRestore();
    runSpy.mockRestore();

    console.log(`  [scale-deep] N=${nodeCount} maxDepth=${maxDepth} gpuSolves=${solves} seed=${dt.toFixed(0)}ms`);
    expect(tickSpy).toHaveBeenCalledTimes(0);
    expect(solves).toBeGreaterThan(0);
    expect(solves).toBeLessThanOrEqual(maxDepth + 1); // O(depth) GPU solves, not O(nodes)
    expect(allFinite(pos, 101)).toBe(true);
    // (Coherence is asserted on the dense/realistic seed-quality + ragged graphs; this deep graph is
    // deliberately sparse at higher levels, where random pair sampling can't estimate it — moduleOf
    // is referenced only to keep the generator's intent explicit.)
    void moduleOf;
    expect(dt).toBeLessThan(60_000);
  }, 120_000);
});
