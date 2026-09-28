/**
 * The GPU multilevel seed on one solver (#353, spec §6.4 / §8, T10), and the module-aware seed it runs for a
 * module tree (#180 / N8.2).
 *
 * 1. **Levels are the CPU's.** A seed level's forces, from identical positions, are the CPU's mass-weighted
 *    forces: repulsion by the other slots' masses, springs `attraction · w / mass`, centering on the
 *    mass-weighted centroid — on an all-pairs level and on a Barnes-Hut level.
 * 2. **Per-level state.** `setLevel` zeroes the level's velocities (by MRT), points the segment at its slots,
 *    and allocates nothing; placing every level without solves lands the graph's nodes exactly where the
 *    plan puts them (a coarsening's prolongation, a module tree's leaf seed).
 * 3. **Seed quality.** A coarsening seed lands at the force equilibrium's scale and keeps clusters together;
 *    the module seed keeps modules coherent, ragged branches at their own density, and every leaf once.
 * 4. **Scale.** A ≈1M-node wide module tree and a deep one seed with no CPU force work, one GPU placement per
 *    level, on one solver.
 * 5. **Portable readback (#351).** A device that reads `rg32f` only as `RGBA/FLOAT` seeds exactly as an
 *    `RG/FLOAT` device.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { makeRgbaReadDevice } from "./_rgba-read-device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { canModuleSeed, coarseSeedPlan, moduleSeedPlan, type SeedLevel, type SeedPlan } from "../seed-plan.js";
import { readbackRgbaFbo } from "../textures.js";
import { gridPyramidReference } from "./grid-pyramid-reference.js";
import { buildHierarchy, multilevelSeed, type CoarseLevel } from "../../coarsen.js";
import { ForceLayout, seedPositions, DEFAULT_FORCE, type ForceParams, type LayoutGraph } from "../../force.js";
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

/** mean(intra-group pair distance) / mean(cross-group pair distance) over sampled pairs: << 1 = coherent. */
function coherence(pos: Float32Array, groupOf: Int32Array, maxPairs = 6000): number {
  const n = pos.length / 2;
  const rng = makePrng(0xc0ffee);
  let intra = 0, ni = 0, inter = 0, ne = 0;
  for (let s = 0; s < maxPairs; s++) {
    const i = Math.floor(rng() * n);
    const j = Math.floor(rng() * n);
    if (i === j) continue;
    const d = Math.hypot(pos[i * 2]! - pos[j * 2]!, pos[i * 2 + 1]! - pos[j * 2 + 1]!);
    if (groupOf[i] === groupOf[j]) { intra += d; ni++; } else { inter += d; ne++; }
  }
  if (ni === 0 || ne === 0) return 1;
  return (intra / ni) / (inter / ne);
}

/** Mean connected edge length. */
function meanEdge(pos: Float32Array, source: Uint32Array, target: Uint32Array): number {
  let sum = 0;
  for (let e = 0; e < source.length; e++) {
    const a = source[e]!, b = target[e]!;
    sum += Math.hypot(pos[a * 2]! - pos[b * 2]!, pos[a * 2 + 1]! - pos[b * 2 + 1]!);
  }
  return sum / Math.max(1, source.length);
}

/** 95th-percentile distance from the centroid. */
function r95(pos: Float32Array): number {
  const n = pos.length / 2;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += pos[i * 2]!; cy += pos[i * 2 + 1]!; }
  cx /= n; cy /= n;
  const r = Array.from({ length: n }, (_, i) => Math.hypot(pos[i * 2]! - cx, pos[i * 2 + 1]! - cy)).sort((a, b) => a - b);
  return r[Math.floor(0.95 * (n - 1))] ?? 0;
}

function allFinite(pos: Float32Array, sampleEvery = 1): boolean {
  for (let i = 0; i < pos.length; i += sampleEvery) if (!Number.isFinite(pos[i]!)) return false;
  return true;
}

// ── graphs ────────────────────────────────────────────────────────────────────

interface Graph extends CoarseLevel {
  groupOf: Int32Array;
}

/** `k` clusters of `m` nodes (node i in cluster i % k, so a disc's order does not cluster them), mostly intra edges. */
function planted(k: number, m: number, intraDeg: number, bridgesPerPair: number, seed: number): Graph {
  const rng = makePrng(seed);
  const n = k * m;
  const groupOf = new Int32Array(n);
  const members: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) { groupOf[i] = i % k; members[i % k]!.push(i); }
  const src: number[] = [], tgt: number[] = [];
  for (const mem of members) {
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
  return { nodeCount: n, source: Uint32Array.from(src), target: Uint32Array.from(tgt), weight: new Float32Array(src.length).fill(1), groupOf };
}

/** `k` clusters of contiguous ids with `perNode` edges each, 90% inside the cluster: coarsens over many levels. */
function clustered(k: number, m: number, perNode: number, seed: number): Graph {
  const rng = makePrng(seed);
  const n = k * m;
  const e = n * perNode;
  const source = new Uint32Array(e), target = new Uint32Array(e);
  const groupOf = new Int32Array(n);
  for (let i = 0; i < n; i++) groupOf[i] = Math.floor(i / m);
  for (let q = 0; q < e; q++) {
    const a = Math.floor(rng() * n);
    source[q] = a;
    target[q] = rng() < 0.9 ? Math.floor(a / m) * m + Math.floor(rng() * m) : Math.floor(rng() * n);
  }
  return { nodeCount: n, source, target, weight: new Float32Array(e).fill(1), groupOf };
}

/** Flat one-level module records: path = [group + 1, rank]. */
function flatRecords(groupOf: Int32Array): ModuleNode[] {
  const rank = new Map<number, number>();
  return Array.from(groupOf, (c, id) => {
    const r = (rank.get(c) ?? 0) + 1; rank.set(c, r);
    return { id, path: [c + 1, r] };
  });
}

function depthsOf(tree: LODTree): Int32Array {
  const parent = tree.parent!;
  const depth = new Int32Array(tree.size);
  for (let g = tree.size - 2; g >= 0; g--) depth[g] = depth[parent[g]!]! + 1;
  return depth;
}

const W = 800;
const H = 600;

/** A multilevel solver over `g`, from the disc the transport seeds (what the solver holds before the seed). */
function solver(device: Device, g: CoarseLevel, force: ForceParams = DEFAULT_FORCE): GpuForceLayout {
  const view: LayoutGraph = { nodeCount: g.nodeCount, edgeCount: g.source.length, source: g.source, target: g.target, positions: new Float32Array(g.nodeCount * 2) };
  seedPositions(view, W, H, { force });
  return new GpuForceLayout(device, view, force, { multilevel: true });
}

/** Run `plan` on a fresh solver and read the graph's seeded positions. */
function gpuSeed(device: Device, g: CoarseLevel, plan: SeedPlan): Float32Array {
  const layout = solver(device, g);
  layout.runSeed(plan);
  const out = new Float32Array(g.nodeCount * 2);
  layout.readPositions(out);
  layout.destroy();
  return out;
}

/**
 * The CPU's forces on a seed level (float64): exact repulsion by the other slots' masses, springs
 * `attraction · w / mass_i`, centering on the mass-weighted centroid — `ForceLayout.tick` with masses, exact.
 */
function levelForces(level: SeedLevel, pos: Float32Array, attraction: number, params: ForceParams = DEFAULT_FORCE): Float64Array {
  const n = level.count;
  const f = new Float64Array(n * 2);
  let cx = 0, cy = 0, mt = 0;
  for (let i = 0; i < n; i++) { const m = level.mass[i]!; cx += m * pos[i * 2]!; cy += m * pos[i * 2 + 1]!; mt += m; }
  cx /= mt; cy /= mt;
  for (let i = 0; i < n; i++) {
    const xi = pos[i * 2]!, yi = pos[i * 2 + 1]!;
    let ax = 0, ay = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = xi - pos[j * 2]!, dy = yi - pos[j * 2 + 1]!;
      const k = (params.repulsion * level.mass[j]!) / (dx * dx + dy * dy + 1e-2);
      ax += k * dx; ay += k * dy;
    }
    let sx = 0, sy = 0;
    for (let p = level.offsets[i]!; p < level.offsets[i + 1]!; p++) {
      const j = level.neighbors[p]!, w = level.weights[p]!;
      sx += w * (pos[j * 2]! - xi); sy += w * (pos[j * 2 + 1]! - yi);
    }
    const ka = attraction / level.mass[i]!;
    f[i * 2] = ax + ka * sx + params.centering * (cx - xi);
    f[i * 2 + 1] = ay + ka * sy + params.centering * (cy - yi);
  }
  return f;
}

/** Per slot `|ΔF| / (|F| + F_s)` (spec §9's statistic, F_s = repulsion / spacing), sorted ascending. */
function relativeErrors(gpu: Float32Array, cpu: Float64Array, params: ForceParams = DEFAULT_FORCE): number[] {
  const fs = params.repulsion / Math.sqrt((Math.PI * params.repulsion) / params.centering);
  const out: number[] = [];
  for (let i = 0; i < cpu.length / 2; i++) {
    const d = Math.hypot(gpu[i * 2]! - cpu[i * 2]!, gpu[i * 2 + 1]! - cpu[i * 2 + 1]!);
    out.push(d / (Math.hypot(cpu[i * 2]!, cpu[i * 2 + 1]!) + fs));
  }
  return out.sort((a, b) => a - b);
}
const quantile = (xs: number[], q: number): number => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? NaN;

/** Place levels 0 … k of `plan` on `layout`, running none of their ticks. */
function stepTo(layout: GpuForceLayout, plan: SeedPlan, k: number): void {
  layout.beginSeed(plan);
  for (let j = 0; j <= k; j++) layout.setLevel(j);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GPU multilevel seed: one solver, the CPU's mass-weighted levels (#353)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("an all-pairs seed level's forces are the CPU's mass-weighted forces, from the same positions", () => {
    const g = clustered(60, 40, 4, 0x11);
    // Levels are placed without their ticks below (stepTo), so the forces are taken at the placement.
    const plan = coarseSeedPlan(g, buildHierarchy(g), { width: W, height: H });
    if (!plan) throw new Error("no plan");
    const k = plan.levels.findIndex((l) => l.count > 200 && l.count <= 4096);
    const level = plan.levels[k];
    if (!level) throw new Error("no all-pairs level");
    expect(level.neighbors.length).toBeGreaterThan(0); // the springs take part
    const layout = solver(device, g);
    stepTo(layout, plan, k);
    const pos = new Float32Array(level.count * 2);
    layout.readPositions(pos);
    layout.beginTick();
    layout.forceBand(0, 1);
    const gpu = new Float32Array(level.count * 2);
    layout.readForces(gpu);
    layout.destroy();
    const errors = relativeErrors(gpu, levelForces(level, pos, plan.attraction));
    console.log(`  [level ${k}, ${level.count} slots, all-pairs] relative force error p50 ${quantile(errors, 0.5).toExponential(2)} p99 ${quantile(errors, 0.99).toExponential(2)} max ${quantile(errors, 1).toExponential(2)}`);
    expect(quantile(errors, 0.99)).toBeLessThan(1e-4);
    expect(quantile(errors, 1)).toBeLessThan(1e-3);
  });

  it("a Barnes-Hut seed level's forces are the mass-weighted grid-pyramid tick's, and near the CPU's exact forces", () => {
    const g = clustered(300, 60, 3, 0x22); // 18k nodes: level 1 is past the all-pairs size
    const plan = coarseSeedPlan(g, buildHierarchy(g), { width: W, height: H });
    if (!plan) throw new Error("no plan");
    const k = plan.levels.findIndex((l) => l.count > 4096);
    const level = plan.levels[k];
    if (!level) throw new Error("no pyramid level");
    const layout = solver(device, g);
    stepTo(layout, plan, k);
    const pos = new Float32Array(level.count * 2);
    layout.readPositions(pos);
    layout.beginTick();
    layout.forceBand(0, 1);
    const gpu = new Float32Array(level.count * 2);
    layout.readForces(gpu);
    layout.destroy();
    // The algorithm's own reference (the flat-equivalence contract's statistic, spec §9): the grid pyramid
    // with the level's masses in its statistics and scatter, weighted springs over the slot's mass.
    const params = { ...DEFAULT_FORCE, attraction: plan.attraction };
    const ref = gridPyramidReference(pos, level.count, level, params, level);
    const vsRef = relativeErrors(gpu, Float64Array.from(ref));
    const outliers = vsRef.filter((r) => r > 1e-2).length;
    // Against exact forces the traversal's approximation remains (θ = 0.9 on a freshly prolongated level:
    // tight phyllotaxis discs, the #251 near field); masses ignored would put the median off by the mean mass.
    const vsExact = relativeErrors(gpu, levelForces(level, pos, plan.attraction));
    console.log(
      `  [level ${k}, ${level.count} slots, Barnes-Hut θ=0.9] vs the mass-weighted pyramid reference p99 ${quantile(vsRef, 0.99).toExponential(2)} ` +
        `(${outliers} over 1e-2); vs exact p50 ${quantile(vsExact, 0.5).toExponential(2)} p99 ${quantile(vsExact, 0.99).toExponential(2)}`,
    );
    expect(quantile(vsRef, 0.99)).toBeLessThan(1e-4);
    expect(outliers).toBeLessThanOrEqual(Math.ceil(0.001 * level.count));
    expect(quantile(vsExact, 0.5)).toBeLessThan(0.03);
    // The tail is the near field's: a heavy supernode sharing its finest cell with lighter ones is repelled by
    // a lump that includes its own mass (≈ m_i / 2m_j too strong, see the repulsion.ts header). Measured
    // p99 0.47 here; bounded so it cannot grow unseen (and would drop if the node's own mass were excluded).
    expect(quantile(vsExact, 0.99)).toBeLessThan(0.6);
  }, 60_000);

  it("setLevel zeroes the level's velocities, points the segment at its slots (mass-weighted), and allocates nothing", () => {
    const g = clustered(80, 50, 4, 0x33);
    const plan = coarseSeedPlan(g, buildHierarchy(g), { width: W, height: H });
    if (!plan) throw new Error("no plan");
    const layout = solver(device, g);
    layout.beginSeed(plan);
    const fboSpy = vi.spyOn(device, "createFramebuffer");
    const texSpy = vi.spyOn(device, "createTexture");
    const bufSpy = vi.spyOn(device, "createBuffer");
    try {
      plan.levels.forEach((level, k) => {
        layout.setLevel(k);
        layout.refreshSegmentStats();
        const stats = readbackRgbaFbo(device, layout.segmentStats.stats);
        const pos = new Float32Array(level.count * 2);
        layout.readPositions(pos);
        let mx = 0, my = 0;
        level.mass.forEach((m, i) => { mx += m * pos[i * 2]!; my += m * pos[i * 2 + 1]!; });
        expect(stats[2], `level ${k}: Σ|v| after setLevel`).toBe(0); // every slot starts at rest
        expect(stats[3], `level ${k}: Σ mass`).toBe(g.nodeCount); // the segment covers the level's slots, weighed
        expect(Math.abs(stats[0]! / stats[3]! - mx / g.nodeCount)).toBeLessThan(1e-3 * (1 + Math.abs(mx / g.nodeCount)));
        expect(Math.abs(stats[1]! / stats[3]! - my / g.nodeCount)).toBeLessThan(1e-3 * (1 + Math.abs(my / g.nodeCount)));
        layout.runFrame(Math.max(2, level.ticks)); // velocities become non-zero before the next level
      });
      // (readbackRgbaFbo creates its own throwaway framebuffers: the test's reads, not the solver's.)
      expect(texSpy).toHaveBeenCalledTimes(0);
      expect(bufSpy).toHaveBeenCalledTimes(0);
      expect(fboSpy).toHaveBeenCalledTimes(plan.levels.length);
    } finally {
      fboSpy.mockRestore();
      texSpy.mockRestore();
      bufSpy.mockRestore();
    }
    layout.endSeed();
    layout.refreshSegmentStats();
    const stats = readbackRgbaFbo(device, layout.segmentStats.stats);
    expect(stats[2]).toBe(0); // the graph's nodes start at rest too
    expect(stats[3]).toBe(g.nodeCount); // unit masses again
    expect(layout.seeding).toBe(false);
    layout.destroy();
  });

  it("a seed compiles nothing: every seed program is built with the solver, so a failed compile fails its construction", async () => {
    // A fresh device, so no earlier solver's programs can be reused from luma's caches.
    const fresh = await makeTestDevice();
    const g = planted(8, 60, 4, 3, 0x35);
    const coarse = coarseSeedPlan(g, buildHierarchy(g), { width: W, height: H });
    const modular = moduleSeedPlan(buildModuleLODTree(g.nodeCount, flatRecords(g.groupOf), g), g, { width: W, height: H });
    if (!coarse || !modular) throw new Error("no plan");
    const proto = WebGL2RenderingContext.prototype;
    for (const plan of [coarse, modular]) {
      const layout = solver(fresh, g);
      const programs = vi.spyOn(proto, "createProgram");
      const shaders = vi.spyOn(proto, "createShader");
      try {
        layout.runSeed(plan);
        expect(programs, "a seed built a program").toHaveBeenCalledTimes(0);
        expect(shaders, "a seed compiled a shader").toHaveBeenCalledTimes(0);
      } finally {
        programs.mockRestore();
        shaders.mockRestore();
        layout.destroy();
      }
    }
    fresh.destroy();
  });

  it("placing every level without solves lands the nodes where the plan puts them: the CPU seed's prolongation", () => {
    const g = clustered(60, 40, 4, 0x44);
    const hierarchy = buildHierarchy(g);
    const plan = coarseSeedPlan(g, hierarchy, { width: W, height: H, coarsenIterations: 0 });
    if (!plan) throw new Error("no plan");
    const got = gpuSeed(device, g, plan);
    const cpu = { ...g, positions: new Float32Array(g.nodeCount * 2) };
    multilevelSeed(cpu, { width: W, height: H, coarsenIterations: 0 }, hierarchy);
    let maxErr = 0, maxAbs = 0;
    for (let i = 0; i < got.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(got[i]! - cpu.positions[i]!));
      maxAbs = Math.max(maxAbs, Math.abs(cpu.positions[i]!));
    }
    expect(maxErr).toBeLessThan(maxAbs * 1e-5);
  });

  it("…and a ragged module tree's leaves reach their nodes through the leaf seed, each exactly once", () => {
    const g = planted(6, 40, 4, 2, 0x55);
    const rank = new Map<number, number>();
    const prefix = (c: number): number[] => (c % 3 === 0 ? [100 + c] : c % 3 === 1 ? [1, 200 + c] : [2, 300 + c, 400 + c]);
    const records: ModuleNode[] = Array.from(g.groupOf, (c, id) => {
      const r = (rank.get(c) ?? 0) + 1; rank.set(c, r);
      return { id, path: [...prefix(c), r] };
    });
    const tree = buildModuleLODTree(g.nodeCount, records, g);
    const plan = moduleSeedPlan(tree, g, { width: W, height: H, coarsenIterations: 0 });
    if (!plan) throw new Error("no plan");
    expect(plan.levels.filter((l) => l.leaves.length > 0).length).toBeGreaterThan(1);
    // The plan's own placement, replayed on the CPU (float32 adds, as the GPU's).
    const expected = new Float32Array(g.nodeCount * 2).fill(NaN);
    let above = Float32Array.from(plan.root);
    for (const level of plan.levels) {
      const pos = new Float32Array(level.count * 2);
      for (let i = 0; i < level.count; i++) {
        pos[i * 2] = above[level.parent[i]! * 2]! + level.offset[i * 2]!;
        pos[i * 2 + 1] = above[level.parent[i]! * 2 + 1]! + level.offset[i * 2 + 1]!;
      }
      for (let q = 0; q < level.leaves.length; q += 2) {
        const s = level.leaves[q]!, node = level.leaves[q + 1]!;
        expected[node * 2] = pos[s * 2]!;
        expected[node * 2 + 1] = pos[s * 2 + 1]!;
      }
      above = pos;
    }
    const got = gpuSeed(device, g, plan);
    let maxErr = 0, maxAbs = 0;
    for (let i = 0; i < got.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(got[i]! - expected[i]!));
      maxAbs = Math.max(maxAbs, Math.abs(expected[i]!));
    }
    expect(allFinite(got)).toBe(true);
    expect(maxErr).toBeLessThanOrEqual(maxAbs * 1e-6);
  });

  it("a coarsening seed lands at the force equilibrium's scale and keeps the clusters together, as the CPU seed does", () => {
    const g = clustered(40, 50, 4, 0x66); // 2000 nodes, clusters of contiguous ids
    const hierarchy = buildHierarchy(g);
    const plan = coarseSeedPlan(g, hierarchy, { width: W, height: H });
    if (!plan) throw new Error("no plan");
    const got = gpuSeed(device, g, plan);
    const cpu = { ...g, positions: new Float32Array(g.nodeCount * 2) };
    multilevelSeed(cpu, { width: W, height: H }, hierarchy);
    const disc = new Float32Array(g.nodeCount * 2);
    seedPositions({ nodeCount: g.nodeCount, edgeCount: 0, source: g.source, target: g.target, positions: disc }, W, H, { force: DEFAULT_FORCE });
    const R95 = Math.sqrt(0.95) * Math.sqrt((DEFAULT_FORCE.repulsion * g.nodeCount) / DEFAULT_FORCE.centering);
    const report = (name: string, p: Float32Array): string =>
      `${name} r95/R95 ${(r95(p) / R95).toFixed(3)} coherence ${coherence(p, g.groupOf).toFixed(3)} mean edge ${meanEdge(p, g.source, g.target).toFixed(0)}`;
    console.log(`  [coarsening seed] ${report("GPU", got)} | ${report("CPU", cpu.positions)} | ${report("disc", disc)}`);
    expect(allFinite(got)).toBe(true);
    expect(r95(got) / R95).toBeGreaterThan(0.7);
    expect(r95(got) / R95).toBeLessThan(1.3);
    expect(coherence(got, g.groupOf)).toBeLessThan(0.5 * coherence(disc, g.groupOf));
    expect(meanEdge(got, g.source, g.target)).toBeLessThan(0.5 * meanEdge(disc, g.source, g.target));
    // The CPU's seed, up to Barnes-Hut vs exact leaves and float32: the same quality.
    expect(meanEdge(got, g.source, g.target)).toBeLessThan(1.3 * meanEdge(cpu.positions, g.source, g.target));
  });
});

describe("GPU multilevel seed from a module tree (#180 N8.2, on one solver)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("seed quality: same-module nodes cluster (better than disc) and refine to a good layout", () => {
    const g = planted(8, 60, 4, 3, 0xa11ce); // 480 nodes
    const tree = buildModuleLODTree(g.nodeCount, flatRecords(g.groupOf), g);
    expect(canModuleSeed(tree, g.nodeCount)).toBe(true);
    const plan = moduleSeedPlan(tree, g, { width: W, height: H });
    if (!plan) throw new Error("no plan");
    const disc = new Float32Array(g.nodeCount * 2);
    seedPositions({ nodeCount: g.nodeCount, edgeCount: 0, source: g.source, target: g.target, positions: disc }, W, H);
    const discCoh = coherence(disc, g.groupOf);

    const layout = solver(device, g);
    layout.runSeed(plan);
    const seed = new Float32Array(g.nodeCount * 2);
    layout.readPositions(seed);
    const seedCoh = coherence(seed, g.groupOf);
    layout.cool(120);
    layout.runFrame(120);
    const out = new Float32Array(g.nodeCount * 2);
    layout.readPositions(out);
    layout.destroy();
    console.log(`  [seed-quality] disc coherence ${discCoh.toFixed(3)} module seed ${seedCoh.toFixed(3)} refined ${coherence(out, g.groupOf).toFixed(3)}`);
    expect(allFinite(seed)).toBe(true);
    expect(seedCoh).toBeLessThan(0.85);
    expect(seedCoh).toBeLessThan(discCoh * 0.9);
    expect(coherence(out, g.groupOf)).toBeLessThan(0.85);
  });

  it("scale: seeds at the force equilibrium, and the cooled refine neither explodes nor collapses", () => {
    // Two module levels (4 super-modules over 16 modules): the mass-weighted levels must land the leaves at
    // the refine's own scale — not a viewport-sized disc it then blows up (#345), nor a crowded one.
    const g = planted(16, 125, 4, 1, 0x5ca1ed); // 2000 nodes
    const rank = new Map<number, number>();
    const records: ModuleNode[] = Array.from(g.groupOf, (c, id) => {
      const r = (rank.get(c) ?? 0) + 1; rank.set(c, r);
      return { id, path: [(c % 4) + 1, c + 1, r] };
    });
    const tree = buildModuleLODTree(g.nodeCount, records, g);
    const plan = moduleSeedPlan(tree, g, { width: W, height: H });
    if (!plan) throw new Error("no plan");
    const R95 = Math.sqrt(0.95) * Math.sqrt((DEFAULT_FORCE.repulsion * g.nodeCount) / DEFAULT_FORCE.centering);
    const layout = solver(device, g);
    layout.runSeed(plan);
    const frame = new Float32Array(g.nodeCount * 2);
    layout.readPositions(frame);
    const seed = r95(frame);
    const iterations = 300;
    layout.cool(iterations);
    let peak = seed;
    for (let t = 0; t < iterations; t += 5) {
      layout.runFrame(5);
      layout.readPositions(frame);
      peak = Math.max(peak, r95(frame));
    }
    layout.destroy();
    const final = r95(frame);
    console.log(`  [scale-eq] seed r95/R95 ${(seed / R95).toFixed(3)} final ${(final / R95).toFixed(3)} peak/final ${(peak / final).toFixed(3)} coherence ${coherence(frame, g.groupOf).toFixed(3)}`);
    expect(allFinite(frame)).toBe(true);
    expect(seed / R95).toBeGreaterThan(0.7);
    expect(seed / R95).toBeLessThan(1.3);
    expect(peak / final).toBeLessThan(1.3);
    expect(final / R95).toBeGreaterThan(0.75);
    expect(coherence(frame, g.groupOf)).toBeLessThan(0.85);
  });

  it("ragged scale: a deeper branch seeds at its own leaves' density, not the whole tree's", () => {
    const K = 16, m = 125;
    const g = planted(K, m, 4, 0, 0x7a66ed);
    const rank = new Map<number, number>();
    const records: ModuleNode[] = Array.from(g.groupOf, (c, id) => {
      const r = (rank.get(c) ?? 0) + 1; rank.set(c, r);
      return { id, path: c % 2 === 0 ? [c + 1, r] : [1000 + (c % 4), c + 1, r] };
    });
    const tree = buildModuleLODTree(g.nodeCount, records, g);
    const plan = moduleSeedPlan(tree, g, { width: W, height: H });
    if (!plan) throw new Error("no plan");
    const pos = gpuSeed(device, g, plan);
    expect(allFinite(pos)).toBe(true);
    const moduleSpread = (odd: boolean): number => {
      let total = 0, count = 0;
      for (let c = odd ? 1 : 0; c < K; c += 2) {
        const mod = new Float32Array(m * 2);
        let q = 0;
        for (let i = 0; i < g.nodeCount; i++) if (g.groupOf[i] === c) { mod[q * 2] = pos[i * 2]!; mod[q * 2 + 1] = pos[i * 2 + 1]!; q++; }
        total += r95(mod);
        count++;
      }
      return total / count;
    };
    const shallow = moduleSpread(false);
    const deep = moduleSpread(true);
    expect(deep / shallow, `deep ${deep.toFixed(0)} vs shallow ${shallow.toFixed(0)}`).toBeLessThan(1.35);
    expect(deep / shallow).toBeGreaterThan(1 / 1.35);
  });

  it("ragged correctness: branches of different depths seed without error, every leaf finite and coherent", () => {
    const K = 6, m = 40;
    const g = planted(K, m, 4, 2, 0x4a66ed);
    const raggedPrefix = (c: number): number[] => {
      if (c % 3 === 0) return [10000 + c];
      if (c % 3 === 2) return [1 + (c % 2), 500 + c, 200 + c];
      return [1 + (c % 2), 100 + c];
    };
    const rank = new Map<number, number>();
    const records: ModuleNode[] = Array.from(g.groupOf, (c, id) => {
      const r = (rank.get(c) ?? 0) + 1; rank.set(c, r);
      return { id, path: [...raggedPrefix(c), r] };
    });
    const tree = buildModuleLODTree(g.nodeCount, records, g);
    const depth = depthsOf(tree);
    const leafDepths = new Set<number>();
    for (let i = 0; i < tree.leafCount; i++) leafDepths.add(depth[i]!);
    expect(leafDepths.size).toBeGreaterThan(1);
    const plan = moduleSeedPlan(tree, g, { width: W, height: H });
    if (!plan) throw new Error("no plan");
    const pos = gpuSeed(device, g, plan);
    expect(allFinite(pos)).toBe(true);
    const coh = coherence(pos, g.groupOf);
    console.log(`  [ragged] leaf depths ${[...leafDepths].sort((a, b) => a - b).join(",")} coherence ${coh.toFixed(3)}`);
    expect(coh).toBeLessThan(0.9);
  });

  it("scale: WIDE hierarchy (≈1M nodes, thousands of top modules) seeds on one GPU solver, no CPU force work", () => {
    const K = 5000, m = 200; // 1,000,000 nodes; 5000 top modules > 4096 → that level is a Barnes-Hut solve
    const g = planted(K, m, 2, 0, 0x5ca1e);
    const rng = makePrng(0xb41d9e);
    const extraSrc: number[] = [], extraTgt: number[] = [];
    for (let e = 0; e < K; e++) { extraSrc.push(Math.floor(rng() * g.nodeCount)); extraTgt.push(Math.floor(rng() * g.nodeCount)); }
    const source = Uint32Array.from([...g.source, ...extraSrc]);
    const target = Uint32Array.from([...g.target, ...extraTgt]);
    const graph: CoarseLevel = { nodeCount: g.nodeCount, source, target, weight: new Float32Array(source.length).fill(1) };
    const tree = buildModuleLODTree(g.nodeCount, flatRecords(g.groupOf), graph);
    const tp = performance.now();
    const plan = moduleSeedPlan(tree, graph, { width: 1600, height: 1200, coarsenIterations: 6 });
    const planMs = performance.now() - tp;
    if (!plan) throw new Error("no plan");
    const tickSpy = vi.spyOn(ForceLayout.prototype, "tick");
    const levelSpy = vi.spyOn(GpuForceLayout.prototype, "setLevel");
    const layout = solver(device, graph);
    const t0 = performance.now();
    layout.runSeed(plan);
    const pos = new Float32Array(g.nodeCount * 2);
    layout.readPositions(pos);
    const dt = performance.now() - t0;
    layout.destroy();
    const levels = levelSpy.mock.calls.length;
    tickSpy.mockRestore();
    levelSpy.mockRestore();
    console.log(`  [scale-wide] N=${g.nodeCount} levels=${plan.levels.length} solved=${plan.levels.filter((l) => l.ticks > 0).length} plan (main thread) ${planMs.toFixed(0)} ms, seed ${dt.toFixed(0)} ms`);
    expect(tickSpy).toHaveBeenCalledTimes(0); // no CPU per-level force work (#180)
    expect(levels).toBe(plan.levels.length); // one solver, one placement per level
    expect(allFinite(pos, 101)).toBe(true);
    expect(dt).toBeLessThan(60_000); // generous SwiftShader tripwire
  }, 120_000);

  it("scale: DEEP hierarchy seeds across many depths on one GPU solver, no CPU force work", () => {
    const B = 4, D = 7, perModule = 16;
    const nodeCount = B ** D * perModule; // 262,144
    const rng = makePrng(0xdeeb);
    const src: number[] = [], tgt: number[] = [];
    const records: ModuleNode[] = new Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const lm = i >> 4;
      const digits: number[] = [];
      let x = lm;
      for (let d = 0; d < D; d++) { digits.push((x % B) + 1); x = Math.floor(x / B); }
      records[i] = { id: i, path: [...digits, (i & 15) + 1] };
      src.push(i); tgt.push(lm * perModule + Math.floor(rng() * perModule));
      if (rng() < 0.02) { src.push(i); tgt.push(Math.floor(rng() * nodeCount)); }
    }
    const graph: CoarseLevel = { nodeCount, source: Uint32Array.from(src), target: Uint32Array.from(tgt), weight: new Float32Array(src.length).fill(1) };
    const tree = buildModuleLODTree(nodeCount, records, graph);
    expect(depthsOf(tree).reduce((a, b) => Math.max(a, b), 0)).toBeGreaterThanOrEqual(8);
    const plan = moduleSeedPlan(tree, graph, { width: 1600, height: 1200, coarsenIterations: 6 });
    if (!plan) throw new Error("no plan");
    const tickSpy = vi.spyOn(ForceLayout.prototype, "tick");
    const layout = solver(device, graph);
    const t0 = performance.now();
    layout.runSeed(plan);
    const pos = new Float32Array(nodeCount * 2);
    layout.readPositions(pos);
    const dt = performance.now() - t0;
    layout.destroy();
    tickSpy.mockRestore();
    console.log(`  [scale-deep] N=${nodeCount} levels=${plan.levels.length} seed ${dt.toFixed(0)} ms`);
    expect(tickSpy).toHaveBeenCalledTimes(0);
    expect(allFinite(pos, 101)).toBe(true);
    expect(dt).toBeLessThan(60_000);
  }, 120_000);
});

describe("GPU multilevel seed on a device that reads rg32f only as RGBA/FLOAT (#351)", () => {
  it("seeds exactly as an RG/FLOAT device (nothing is read back until the nodes are placed)", async () => {
    const g = clustered(30, 40, 4, 0x77);
    const plan = (): SeedPlan => {
      const p = coarseSeedPlan(g, buildHierarchy(g), { width: W, height: H });
      if (!p) throw new Error("no plan");
      return p;
    };
    const rgDevice = await makeTestDevice();
    const expected = gpuSeed(rgDevice, g, plan());
    rgDevice.destroy();
    expect(allFinite(expected)).toBe(true);
    const rgba = await makeRgbaReadDevice();
    try {
      const got = gpuSeed(rgba.device, g, plan());
      expect(rgba.rejectedRgReads()).toBe(0);
      let mismatches = 0;
      for (let i = 0; i < got.length; i++) if (got[i] !== expected[i]) mismatches++;
      expect(mismatches).toBe(0);
    } finally {
      rgba.device.destroy();
      rgba.restore();
    }
  });
});
