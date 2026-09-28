/**
 * T5 — flat equivalence (spec §9, §13): the S = 1 segmented solver against
 * {@link gridPyramidReference}, the float32 executable spec of the flat pyramid tick.
 *
 * Forces, not trajectories: at every checked tick the GPU's force texture (springs + repulsion +
 * centering, accumulated from the positions that tick started from) is compared with the
 * reference evaluated on the SAME positions, read back bit-exactly. BH makes discontinuous
 * decisions (level-0 binning, the θ-accept), so one ulp can flip a node into the next cell; the
 * contract is statistical:
 *
 *   r_i = |ΔF_i| / (|F_i| + F_s),  F_s = repulsion / spacing (≈ 3.6 with the defaults)
 *   p99(r) ≤ 1e-4, and at most 0.1% of nodes with r > 1e-2 (decision flips).
 *
 * The reference's box (exact min/max) and grid (`chooseGrid(N)`) are the pre-segment pyramid's, so
 * a match at this tolerance also pins the structure: the S = 1 segment is today's single grid.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { chooseGrid } from "../passes/grid-pyramid.js";
import { buildCSR, buildGraph } from "../../graph.js";
import { DEFAULT_FORCE, equilibriumSpacing, seedPositions } from "../../force.js";
import { gridPyramidReference, referenceStats } from "./grid-pyramid-reference.js";

/** Minimal seeded LCG PRNG — self-contained, no deps. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Quantile of a sorted array. */
function quantile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

describe("flat equivalence — S = 1 solver vs the grid-pyramid reference (T5)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("per-node forces from identical positions: p99(r) ≤ 1e-4, ≤ 0.1% of nodes with r > 1e-2, over 10 ticks", () => {
    // N = 5k with the pyramid forced (the auto threshold would pick all-pairs at ≤ 4096) and
    // degrees ≤ 256 (every CSR row is gathered whole).
    const count = 5000;
    const rng = makePrng(0xf1a7);
    const src: number[] = [];
    const tgt: number[] = [];
    for (let i = 0; i < count; i++) {
      src.push(i);
      tgt.push((i + 1) % count); // a ring keeps it connected
      for (let k = 0; k < 2; k++) {
        src.push(i);
        tgt.push(Math.floor(rng() * count));
      }
    }
    const g = buildGraph({ nodeCount: count, source: src, target: tgt });
    const csr = buildCSR(count, g.source, g.target);
    let maxDegree = 0;
    for (let i = 0; i < count; i++) maxDegree = Math.max(maxDegree, (csr.offsets[i + 1] ?? 0) - (csr.offsets[i] ?? 0));
    expect(maxDegree).toBeLessThanOrEqual(256);

    const params = { ...DEFAULT_FORCE };
    seedPositions(g, 800, 600, { force: params });
    const layout = new GpuForceLayout(device, g, params, { repulsionMode: "pyramid" });
    const fs = params.repulsion / equilibriumSpacing(params);
    expect(chooseGrid(count)).toBe(128);

    const positions = new Float32Array(count * 2);
    const forces = new Float32Array(count * 2);
    const r = new Float64Array(count);
    let worstP99 = 0;
    let worstOutliers = 0;
    for (let tick = 0; tick < 10; tick++) {
      layout.readPositions(positions); // the positions this tick starts from, bit-exact
      layout.runFrame(1);
      layout.readForces(forces);
      const ref = gridPyramidReference(positions, count, csr, params);
      let outliers = 0;
      for (let i = 0; i < count; i++) {
        const dx = (forces[i * 2] ?? 0) - (ref[i * 2] ?? 0);
        const dy = (forces[i * 2 + 1] ?? 0) - (ref[i * 2 + 1] ?? 0);
        const mag = Math.hypot(ref[i * 2] ?? 0, ref[i * 2 + 1] ?? 0);
        r[i] = Math.hypot(dx, dy) / (mag + fs);
        if ((r[i] ?? 0) > 1e-2) outliers++;
      }
      r.sort();
      const p99 = quantile(r, 0.99);
      worstP99 = Math.max(worstP99, p99);
      worstOutliers = Math.max(worstOutliers, outliers);
      expect(p99, `tick ${tick}: p99(r)`).toBeLessThanOrEqual(1e-4);
      expect(outliers, `tick ${tick}: nodes with r > 1e-2`).toBeLessThanOrEqual(Math.floor(0.001 * count));
    }
    console.log(
      `  T5 flat equivalence (N=${count}, G=${chooseGrid(count)}, 10 ticks): worst p99(r)=${worstP99.toExponential(2)}` +
      `, worst outliers (r > 1e-2)=${worstOutliers}/${count}`,
    );
    layout.destroy();
  });

  it("the reference's reduction order agrees with a float64 centroid within the §6.1 bound", () => {
    // The reference mirrors the GPU add order; this pins that the order itself is the accurate one.
    const count = 5000;
    const g = buildGraph({ nodeCount: count, source: [], target: [] });
    seedPositions(g, 800, 600, { force: DEFAULT_FORCE });
    const stats = referenceStats(g.positions, count);
    let sx = 0, ax = 0;
    for (let i = 0; i < count; i++) {
      sx += g.positions[i * 2] ?? 0;
      ax += Math.abs(g.positions[i * 2] ?? 0);
    }
    expect(stats.count).toBe(count);
    // D ≤ 4·L + 15·L for [0, N); L = 3 at 5k.
    expect(Math.abs(stats.sumX - sx)).toBeLessThanOrEqual(2 * (4 * 3 + 15 * 3) * 2 ** -23 * ax);
  });
});
