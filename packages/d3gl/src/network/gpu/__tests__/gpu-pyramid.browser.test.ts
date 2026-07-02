/**
 * GPU grid-pyramid + Barnes-Hut repulsion tests (Task 5).
 *
 * Step A — pyramid BUILD correctness: seed a handful of nodes, build the
 * regular-quadtree COM/mass pyramid, read the 1×1 ROOT texel, and assert
 *   root.mass == count           (unit mass ⇒ node count)
 *   root COM (Σx/mass, Σy/mass) ≈ centroid of the seed positions.
 *
 * Step B — BH traversal correctness + perf:
 *   - per-node repulsion force from the pyramid pass agrees with the exact
 *     all-pairs pass within a tolerance (θ≈0.5) on a 2000-node graph;
 *   - the pyramid path is ≥3× faster than all-pairs at a SwiftShader-feasible N
 *     (RELATIVE speedup — absolute frame budgets are validated on real GPU in
 *     Task 7, not this software-GL test).
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GridPyramid, chooseGrid } from "../passes/grid-pyramid.js";
import { packPositionsTexture, readbackRgbaFbo } from "../textures.js";

/** Minimal seeded LCG PRNG — self-contained, no deps. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

describe("GPU grid pyramid — build correctness (Step A)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("chooseGrid clamps to [16,1024] and returns a power of two", () => {
    expect(chooseGrid(1)).toBe(16);
    expect(chooseGrid(200)).toBe(16); // ceil(sqrt(200))=15 → 16
    expect(chooseGrid(2000)).toBe(64); // ceil(sqrt(2000))=45 → 64
    expect(chooseGrid(1_000_000)).toBe(1024);
    // power-of-two check
    for (const n of [1, 300, 5000, 250_000, 2_000_000]) {
      const g = chooseGrid(n);
      expect((g & (g - 1))).toBe(0);
    }
  });

  it("root texel holds total mass = count and COM = centroid of seed positions", () => {
    // A handful of nodes at varied positions (deliberately not symmetric).
    const positions = new Float32Array([
      10, 20,
      -30, 5,
      40, -15,
      0, 0,
      100, 100,
      -50, 60,
      25, -80,
    ]);
    const count = positions.length / 2;

    const { texture: posTex, width } = packPositionsTexture(device, positions);
    const pyramid = new GridPyramid(device, count);
    pyramid.build({ posTex, count, width });

    // Root = last level (1×1). Read (Σx, Σy, mass, 0).
    const rootTex = pyramid.levelTexture(pyramid.levelCount - 1);
    const root = readbackRgbaFbo(device, rootTex); // length 4
    const sumX = root[0]!;
    const sumY = root[1]!;
    const mass = root[2]!;

    // Expected CPU centroid.
    let cx = 0, cy = 0;
    for (let i = 0; i < count; i++) { cx += positions[i * 2]!; cy += positions[i * 2 + 1]!; }
    cx /= count; cy /= count;

    expect(mass).toBeCloseTo(count, 5);
    expect(sumX / mass).toBeCloseTo(cx, 3);
    expect(sumY / mass).toBeCloseTo(cy, 3);

    pyramid.destroy();
    posTex.destroy();
  });

  it("mass is conserved across all pyramid levels (each level sums to count)", () => {
    const rng = makePrng(0xabcdef);
    const count = 500;
    const positions = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      positions[i * 2] = (rng() - 0.5) * 1000;
      positions[i * 2 + 1] = (rng() - 0.5) * 1000;
    }
    const { texture: posTex, width } = packPositionsTexture(device, positions);
    const pyramid = new GridPyramid(device, count);
    pyramid.build({ posTex, count, width });

    // Every level's total mass (Σ over all cells of channel 2) must equal count.
    for (let lvl = 0; lvl < pyramid.levelCount; lvl++) {
      const tex = pyramid.levelTexture(lvl);
      const data = readbackRgbaFbo(device, tex);
      let totalMass = 0;
      for (let t = 0; t < data.length; t += 4) totalMass += data[t + 2]!;
      expect(totalMass).toBeCloseTo(count, 2);
    }

    pyramid.destroy();
    posTex.destroy();
  });
});
