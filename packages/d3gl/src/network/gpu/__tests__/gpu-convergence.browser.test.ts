/**
 * GPU convergence parity test.
 *
 * Runs both the CPU ForceLayout and the GpuForceLayout on an identical small
 * graph (200 nodes, 3 communities with bridge edges) from the SAME seeded
 * start positions and compares layout quality via an orientation/scale-invariant
 * metric: spreadRatio = meanConnectedEdgeLength / meanSampledPairDistance.
 *
 * A good layout has spreadRatio << 1 (connected nodes are closer than random
 * node pairs). The test asserts:
 *   1. gpuRatio < 1.0  — GPU produced a genuinely good layout.
 *   2. |gpuRatio − cpuRatio| / cpuRatio < 0.35  — GPU quality is comparable to CPU.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { ForceLayout, seedPositions, DEFAULT_FORCE } from "../../force.js";
import type { LayoutGraph } from "../../force.js";

// ─── deterministic graph generation ─────────────────────────────────────────

/** Minimal seeded LCG PRNG — keeps the test self-contained, no deps. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

interface TestGraph extends LayoutGraph {
  // LayoutGraph already has source/target/positions/nodeCount/edgeCount
}

/**
 * Generate a small deterministic graph:
 *   - `k` communities of `m` nodes each, densely intra-connected (Erdős–Rényi p=0.5)
 *   - a handful of random inter-community bridge edges (bridgesPerPair × k×(k−1)/2 pairs)
 *
 * Returns a LayoutGraph with Uint32Array source/target and Float32Array positions
 * (all zeros — caller seeds positions separately).
 */
function makeClusteredGraph(
  k: number,
  m: number,
  bridgesPerPair: number,
  seed: number,
): TestGraph {
  const rng = makePrng(seed);
  const nodeCount = k * m;
  const srcArr: number[] = [];
  const tgtArr: number[] = [];

  // Intra-community dense edges
  for (let c = 0; c < k; c++) {
    const base = c * m;
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        if (rng() < 0.5) {
          srcArr.push(base + i);
          tgtArr.push(base + j);
        }
      }
    }
  }

  // Inter-community bridge edges
  for (let a = 0; a < k; a++) {
    for (let b = a + 1; b < k; b++) {
      for (let br = 0; br < bridgesPerPair; br++) {
        const u = a * m + Math.floor(rng() * m);
        const v = b * m + Math.floor(rng() * m);
        srcArr.push(u);
        tgtArr.push(v);
      }
    }
  }

  const edgeCount = srcArr.length;
  return {
    nodeCount,
    edgeCount,
    source: Uint32Array.from(srcArr),
    target: Uint32Array.from(tgtArr),
    positions: new Float32Array(nodeCount * 2),
  };
}

// ─── metric ─────────────────────────────────────────────────────────────────

/**
 * spreadRatio = meanConnectedEdgeLength / meanSampledPairDistance.
 *
 * Samples at most `maxPairs` random node pairs for the denominator
 * (exact O(n²) for small graphs, capped otherwise). A ratio << 1 means
 * connected nodes are much closer than random pairs → good layout.
 */
function spreadRatio(
  pos: Float32Array,
  source: Uint32Array,
  target: Uint32Array,
  maxPairs = 2000,
): number {
  const edgeCount = source.length;
  if (edgeCount === 0) return 1; // degenerate: no edges

  // Mean connected edge length
  let edgeLen = 0;
  for (let e = 0; e < edgeCount; e++) {
    const a = source[e]!;
    const b = target[e]!;
    const dx = pos[a * 2]! - pos[b * 2]!;
    const dy = pos[a * 2 + 1]! - pos[b * 2 + 1]!;
    edgeLen += Math.sqrt(dx * dx + dy * dy);
  }
  edgeLen /= edgeCount;

  // Mean sampled pair distance
  const n = pos.length / 2;
  const rng = makePrng(0xc0ffee);
  let pairDist = 0;
  const count = Math.min(maxPairs, (n * (n - 1)) / 2);
  for (let k = 0; k < count; k++) {
    const i = Math.floor(rng() * n);
    let j = Math.floor(rng() * (n - 1));
    if (j >= i) j++;
    const dx = pos[i * 2]! - pos[j * 2]!;
    const dy = pos[i * 2 + 1]! - pos[j * 2 + 1]!;
    pairDist += Math.sqrt(dx * dx + dy * dy);
  }
  pairDist /= count;

  if (pairDist < 1e-10) return 1; // degenerate
  return edgeLen / pairDist;
}

// ─── test ───────────────────────────────────────────────────────────────────

describe("GpuForceLayout convergence parity vs CPU", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("GPU layout quality is comparable to CPU ForceLayout", () => {
    // Generate graph: 4 communities × 50 nodes = 200 nodes, 3 bridges per pair.
    const graph = makeClusteredGraph(4, 50, 3, 0xdeadbeef);

    // Seed positions using the same phyllotaxis as the CPU layout.
    const W = 800;
    const H = 600;
    seedPositions(graph, W, H);

    // Make identical copies for CPU and GPU.
    const cpuPositions = graph.positions.slice();
    const gpuPositions = graph.positions.slice();

    // Use theta:0 (exact O(n²) all-pairs) for CPU so both use the same repulsion
    // algorithm (GPU is always exact all-pairs; Barnes-Hut θ≈0.9 produces
    // systematically different force magnitudes and a divergent layout metric).
    const params = { ...DEFAULT_FORCE, theta: 0 };

    // ── CPU run ──────────────────────────────────────────────────────────────
    const cpuGraph: LayoutGraph = {
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      source: graph.source,
      target: graph.target,
      positions: cpuPositions,
    };
    const cpu = new ForceLayout(cpuGraph, params);
    cpu.run(150);

    // ── GPU run ──────────────────────────────────────────────────────────────
    const gpuGraph: LayoutGraph = {
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      source: graph.source,
      target: graph.target,
      positions: gpuPositions,
    };
    const gpu = new GpuForceLayout(device, gpuGraph, params);
    gpu.runFrame(150);
    const gpuPos = new Float32Array(graph.nodeCount * 2);
    gpu.readPositions(gpuPos);

    const cpuRatio = spreadRatio(cpuPositions, graph.source, graph.target);
    const gpuRatio = spreadRatio(gpuPos, graph.source, graph.target);

    // Diagnostic: show layout extents to understand scale difference
    let cpuMinX = Infinity, cpuMaxX = -Infinity, gpuMinX = Infinity, gpuMaxX = -Infinity;
    for (let i = 0; i < graph.nodeCount; i++) {
      const cx = cpuPositions[i * 2]!;
      const gx = gpuPos[i * 2]!;
      if (cx < cpuMinX) cpuMinX = cx; if (cx > cpuMaxX) cpuMaxX = cx;
      if (gx < gpuMinX) gpuMinX = gx; if (gx > gpuMaxX) gpuMaxX = gx;
    }
    console.log(`  cpuRatio=${cpuRatio.toFixed(4)} gpuRatio=${gpuRatio.toFixed(4)} relDiff=${(Math.abs(gpuRatio - cpuRatio) / cpuRatio).toFixed(4)}`);
    console.log(`  cpuExtent=[${cpuMinX.toFixed(1)}, ${cpuMaxX.toFixed(1)}]  gpuExtent=[${gpuMinX.toFixed(1)}, ${gpuMaxX.toFixed(1)}]`);

    // 1. GPU layout is genuinely good (connected nodes closer than random pairs).
    expect(gpuRatio).toBeLessThan(1.0);

    // 2. GPU quality is comparable to CPU (within 35% relative difference).
    const relDiff = Math.abs(gpuRatio - cpuRatio) / cpuRatio;
    expect(relDiff).toBeLessThan(0.35);
  });
});
