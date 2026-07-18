/**
 * GPU layout stability + hull shape (#203).
 *
 * Guards the two halves of the "axis-aligned square layout" fix:
 *   1. **Spring-stiffness stabilizer** — a high-degree hub's aggregate spring gain
 *      (K̃ = damping·α·attraction·degree) used to cross the explicit integrator's oscillatory
 *      stability bound (K̃ ≈ 3.8); the hub then ejected itself and its cluster ballistically and
 *      the whole layout ran away (contained only by the step clamp → permanent maxStep jitter).
 *      The per-node 1/(1+K̃) stabilizer (integrate pass, mirrored in CPU force.ts) makes the
 *      spring mode unconditionally stable — so a hub-heavy layout must SETTLE, not just stay finite.
 *   2. **Isotropic step clamp** — the old component-wise clamp mapped every runaway step onto the
 *      boundary of a square, sending ejected clusters along exactly ±45° into the four corners of
 *      an axis-aligned box. With the runaway fixed and the clamp isotropic, a module-seeded large
 *      layout must keep an organic, roughly circular hull.
 *
 * Empirical BEFORE numbers (10k LFR-like graph, module seed, 300 ticks, SwiftShader):
 * hull circularity 0.63, span 4.3× the seed span, step-clamp saturation every tick.
 * AFTER: circularity 0.99, span 1.3× seed span, zero saturation. Thresholds below sit
 * between the two with wide margins.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { gpuMultilevelSeed, canModuleSeed } from "../gpu-multilevel-seed.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { seedPositions, DEFAULT_FORCE } from "../../force.js";
import { buildGraph } from "../../graph.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";

// ── deterministic PRNG ────────────────────────────────────────────────────────
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

// ── hull metrics ──────────────────────────────────────────────────────────────

/** Convex hull (monotone chain) circularity 4πA/P²: disc → 1, square → 0.785, spiky → lower. */
function hullCircularity(positions: Float32Array, n: number): number {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([positions[i * 2]!, positions[i * 2 + 1]!]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const pt of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const pt = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, pt) <= 0) upper.pop();
    upper.push(pt);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let area2 = 0; // twice the signed area (shoelace)
  let perim = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    area2 += a[0] * b[1] - b[0] * a[1];
    perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return (4 * Math.PI * (Math.abs(area2) / 2)) / (perim * perim);
}

/** Max bbox side. */
function span(positions: Float32Array, n: number): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

/** Fraction of nodes in the outer bbox corner cells (both |coords| > 0.85 of the half-extents). */
function cornerMass(positions: Float32Array, n: number): number {
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    cx += positions[i * 2]!;
    cy += positions[i * 2 + 1]!;
  }
  cx /= n;
  cy /= n;
  let hx = 0, hy = 0;
  for (let i = 0; i < n; i++) {
    hx = Math.max(hx, Math.abs(positions[i * 2]! - cx));
    hy = Math.max(hy, Math.abs(positions[i * 2 + 1]! - cy));
  }
  let corner = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(positions[i * 2]! - cx) > 0.85 * hx && Math.abs(positions[i * 2 + 1]! - cy) > 0.85 * hy) corner++;
  }
  return corner / n;
}

/** Max per-node displacement between two position snapshots. */
function maxDisplacement(a: Float32Array, b: Float32Array, n: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    m = Math.max(m, Math.hypot(b[i * 2]! - a[i * 2]!, b[i * 2 + 1]! - a[i * 2 + 1]!));
  }
  return m;
}

function allFinite(pos: Float32Array): boolean {
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i]!)) return false;
  return true;
}

// ── planted-module graph with power-law-tail hubs (the #203 trigger shape) ────

interface HubbyModularGraph {
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
  records: ModuleNode[];
}

/**
 * `k` modules of `m` nodes with dense intra-edges, a few inter-module bridges, and a handful of
 * HUB nodes wired to hundreds of random targets. Every edge is emitted as a reciprocal directed
 * pair (like the website modular-map example), so hub spring multiplicity = 2 × degree — the
 * configuration that used to cross the integrator's stability bound. Ragged module prefixes give
 * the module tree branches of different depths (exercises the module-aware seed like the example).
 */
function makeHubbyModularGraph(k: number, m: number, seed: number): HubbyModularGraph {
  const rng = makePrng(seed);
  const nodeCount = k * m;
  const src: number[] = [];
  const tgt: number[] = [];
  const addPair = (a: number, b: number): void => {
    src.push(a, b);
    tgt.push(b, a);
  };
  for (let c = 0; c < k; c++) {
    const base = c * m;
    for (let i = 0; i < m; i++) {
      for (let e = 0; e < 4; e++) {
        const j = Math.floor(rng() * m);
        if (j !== i) addPair(base + i, base + j);
      }
    }
    // Two random inter-module bridges per module.
    for (let b = 0; b < 2; b++) addPair(base + Math.floor(rng() * m), Math.floor(rng() * nodeCount));
  }
  // Hubs: node 0 of the first 6 modules gets 400 random targets → spring multiplicity ≈ 800+,
  // K̃ ≈ 7 at DEFAULT_FORCE — past the old stability bound (≈3.8), the #203 runaway trigger.
  for (let h = 0; h < 6; h++) {
    const hub = h * m;
    for (let e = 0; e < 400; e++) addPair(hub, Math.floor(rng() * nodeCount));
  }
  const raggedPrefix = (c: number): number[] => {
    if (c % 4 === 0) return [10000 + c];
    if (c % 4 === 3) return [1 + (c >> 2), 500 + (c >> 2), 200 + c];
    return [1 + (c >> 2), 100 + c];
  };
  const records: ModuleNode[] = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const c = Math.floor(i / m);
    records[i] = { id: i, path: [...raggedPrefix(c), (i % m) + 1] };
  }
  return {
    nodeCount,
    source: Uint32Array.from(src),
    target: Uint32Array.from(tgt),
    weight: new Float32Array(src.length).fill(1),
    records,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GPU layout stability + hull shape (#203)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("a high-degree hub settles instead of oscillating (integrate-pass spring stabilizer)", { timeout: 120_000 }, () => {
    // Star hub with 1200 leaves, doubled → 2400 spring incidences (K̃ ≈ 21.6 at defaults). The GPU
    // mirror of the CPU force.test.ts case: pre-#203 the hub bounces at ~maxStep every tick forever.
    const n = 1201;
    const src: number[] = [];
    const tgt: number[] = [];
    for (let i = 1; i < n; i++) {
      src.push(0, i);
      tgt.push(i, 0);
    }
    const g = buildGraph({ nodeCount: n, source: src, target: tgt });
    seedPositions(g, 1000, 1000);

    const layout = new GpuForceLayout(device, g, DEFAULT_FORCE);
    layout.runFrame(299);
    const before = new Float32Array(n * 2);
    layout.readPositions(before);
    layout.runFrame(1);
    const after = new Float32Array(n * 2);
    layout.readPositions(after);
    layout.destroy();

    expect(allFinite(after)).toBe(true);
    expect(span(after, n)).toBeLessThan(50_000); // no runaway drift
    expect(maxDisplacement(before, after, n)).toBeLessThan(20); // settled — pre-#203 ≈ maxStep (4000)
  });

  it("module-seeded hub-heavy layout keeps an organic isotropic hull (no square, no runaway)", { timeout: 300_000 }, () => {
    // 160 modules × 50 = 8000 nodes (> GPU_REPULSION_ALLPAIRS_MAX → the BH pyramid path users get
    // at scale), module-aware GPU seed like the modular-map example, then a full 300-tick refine.
    const W = 1024;
    const H = 768;
    const g = makeHubbyModularGraph(160, 50, 0x203203);
    const positions = new Float32Array(g.nodeCount * 2);
    const graph = { nodeCount: g.nodeCount, edgeCount: g.source.length, source: g.source, target: g.target, positions };

    const tree = buildModuleLODTree(g.nodeCount, g.records, { source: g.source, target: g.target, weight: g.weight });
    expect(canModuleSeed(tree, g.nodeCount)).toBe(true);
    gpuMultilevelSeed(device, tree, graph, { width: W, height: H, force: DEFAULT_FORCE });
    const seedSpan = span(positions, g.nodeCount);

    const layout = new GpuForceLayout(device, graph, DEFAULT_FORCE);
    layout.runFrame(290);
    const before = new Float32Array(g.nodeCount * 2);
    layout.readPositions(before);
    layout.runFrame(10);
    const after = new Float32Array(g.nodeCount * 2);
    layout.readPositions(after);
    layout.destroy();

    const finalSpan = span(after, g.nodeCount);
    const circ = hullCircularity(after, g.nodeCount);
    const corner = cornerMass(after, g.nodeCount);
    const settle = maxDisplacement(before, after, g.nodeCount) / 10;
    console.log(`  [hull #203] circ=${circ.toFixed(3)} corner=${(corner * 100).toFixed(2)}% span=${finalSpan.toFixed(0)} (seed ${seedSpan.toFixed(0)}) lastTickStep=${settle.toFixed(2)}`);

    expect(allFinite(after)).toBe(true);
    // Organic, roughly circular hull — the #203 square/spiky runaway sat at ~0.63.
    expect(circ).toBeGreaterThan(0.85);
    // No corner clusters (component-clamped ejecta piled into the bbox corners).
    expect(corner).toBeLessThan(0.01);
    // Refine settles near its equilibrium instead of running away (was > 4× the seed span).
    expect(finalSpan).toBeLessThan(3 * Math.max(seedSpan, 1));
    // Genuinely settled: mean per-tick displacement over the last 10 ticks is tiny relative to the
    // layout (pre-#203 runaway clusters moved at ~the step clamp, thousands of units per tick).
    expect(settle).toBeLessThan(0.02 * finalSpan);
  });
});
