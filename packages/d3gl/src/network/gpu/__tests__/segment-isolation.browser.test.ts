/**
 * T2 — segment isolation, and the tiles against the segmented reference (spec §13 T2/T3, #354).
 *
 * Forces never cross a segment: repulsion (on the tile path and on the exact path), springs and
 * centering act only between the slots of one segment. So moving one segment's positions must leave
 * every other segment's force texels BITWISE unchanged — the same program on the same inputs is
 * deterministic (§9), which makes bitwise the right contract. And each segment's forces must be what
 * the float32 reference computes for that segment alone (`segmentedReference`), within the §9
 * statistic — which pins the tile origins, the per-tile roots, the per-segment box and centroid.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { buildCSR, buildGraph } from "../../graph.js";
import { DEFAULT_FORCE, equilibriumSpacing, type LayoutGraph } from "../../force.js";
import { TILE_MIN_SIDE, packTiles, segmentSoftening, type SlotRange } from "../segments.js";
import { segmentedReference, type ReferenceSegment } from "./grid-pyramid-reference.js";

/** Minimal seeded LCG PRNG — self-contained, no deps. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Segments of the given sizes, laid out contiguously from slot 0. */
function segmentsOf(counts: readonly number[]): SlotRange[] {
  let start = 0;
  return counts.map((count) => {
    const seg = { start, count };
    start += count;
    return seg;
  });
}

/**
 * A graph whose springs stay inside each segment (a ring per segment plus `extra` random links per
 * slot to slots of the same segment), and positions in one shared world region: segment `s` is a
 * square of side `spreads[s]` around the origin, so every segment overlaps every other.
 */
function segmentedGraph(segments: readonly SlotRange[], spreads: readonly number[], extra: number, seed: number): LayoutGraph {
  const rng = makePrng(seed);
  const src: number[] = [];
  const tgt: number[] = [];
  for (const seg of segments) {
    if (seg.count < 2) continue;
    for (let k = 0; k < seg.count; k++) {
      const i = seg.start + k;
      src.push(i);
      tgt.push(seg.start + ((k + 1) % seg.count));
      for (let e = 0; e < extra; e++) {
        src.push(i);
        tgt.push(seg.start + Math.floor(rng() * seg.count));
      }
    }
  }
  const n = segments.reduce((m, s) => Math.max(m, s.start + s.count), 0);
  const g = buildGraph({ nodeCount: n, source: src, target: tgt });
  segments.forEach((seg, s) => {
    const spread = spreads[s] ?? 1000;
    for (let i = seg.start; i < seg.start + seg.count; i++) {
      g.positions[i * 2] = (rng() - 0.5) * spread;
      g.positions[i * 2 + 1] = (rng() - 0.5) * spread;
    }
  });
  return g;
}

/** The forces of one tick from `positions` (a fresh layout, so velocities are zero). */
function forcesAt(device: Device, graph: LayoutGraph, positions: Float32Array, segments: readonly SlotRange[], exactMax: number): Float32Array {
  const layout = new GpuForceLayout(device, { ...graph, positions: positions.slice() }, { ...DEFAULT_FORCE }, { segments, exactMax });
  layout.runFrame(1);
  const out = new Float32Array(graph.nodeCount * 2);
  layout.readForces(out);
  layout.destroy();
  return out;
}

/** The bits of `a`'s texels for the slots of `seg`. */
function bitsOf(a: Float32Array, seg: SlotRange): number[] {
  return Array.from(new Uint32Array(a.buffer, a.byteOffset + seg.start * 8, seg.count * 2));
}

describe("segment isolation (T2)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  // exactMax 32: A and C get tiles of different sides (64, and 32 at the nonzero origin (64, 0)), B takes
  // the exact loop.
  const segments = segmentsOf([1100, 24, 400]);
  const exactMax = 32;
  const graph = segmentedGraph(segments, [1200, 300, 800], 2, 0x150);

  it("the fixture exercises both paths", () => {
    const atlas = packTiles(segments, exactMax, TILE_MIN_SIDE);
    expect(atlas.tiles.map((t) => t && [t.x, t.y, t.side])).toEqual([[0, 0, 64], null, [64, 0, 32]]);
  });

  it("moving one segment's positions leaves every other segment's force texels bitwise unchanged", () => {
    const base = forcesAt(device, graph, graph.positions, segments, exactMax);
    const rng = makePrng(0x3c1);
    segments.forEach((moved, m) => {
      // Scatter the moved segment somewhere else in the same region (a new box, a new centroid, new springs).
      const positions = graph.positions.slice();
      for (let i = moved.start; i < moved.start + moved.count; i++) {
        positions[i * 2] = 150 + (rng() - 0.5) * 900;
        positions[i * 2 + 1] = -80 + (rng() - 0.5) * 500;
      }
      const after = forcesAt(device, graph, positions, segments, exactMax);
      segments.forEach((seg, s) => {
        if (s === m) {
          // Non-vacuity: the moved segment's own forces do change.
          expect(bitsOf(after, seg), `segment ${s} moved`).not.toEqual(bitsOf(base, seg));
        } else {
          expect(bitsOf(after, seg), `segment ${s} after moving segment ${m}`).toEqual(bitsOf(base, seg));
        }
      });
    });
  });

  it("a spring across two segments is rejected at construction, before any GPU allocation", () => {
    const g = buildGraph({ nodeCount: 6, source: [0, 2], target: [1, 3] });
    // A throw after an allocation would leak it: the half-built layout is never returned to destroy().
    const texSpy = vi.spyOn(device, "createTexture");
    const fboSpy = vi.spyOn(device, "createFramebuffer");
    const bufSpy = vi.spyOn(device, "createBuffer");
    try {
      expect(
        () => new GpuForceLayout(device, g, { ...DEFAULT_FORCE }, { segments: segmentsOf([3, 3]) }),
      ).toThrow(/edge 1 joins slot 2 \(segment 0\) and slot 3 \(segment 1\)/);
      expect(texSpy).toHaveBeenCalledTimes(0);
      expect(fboSpy).toHaveBeenCalledTimes(0);
      expect(bufSpy).toHaveBeenCalledTimes(0);
    } finally {
      texSpy.mockRestore();
      fboSpy.mockRestore();
      bufSpy.mockRestore();
    }
  });

  it("softening is per segment: world 1e-2 on both paths; unit 1e-9 on the exact loop and 1e-8 on a tile", () => {
    // Segment 0: 2 slots (exact at exactMax 2); segment 1: 3 slots (a tile of side 8). All pairs are
    // ~1e-3 apart, so d² ≈ 1e-6 and ε is visible: 1e-2 dominates it, 1e-8 moves the force by 1%, 1e-9
    // by 0.1%. On the tile every node sits in its own finest cell and every other cell is θ-accepted
    // (a point body), so both paths reduce to Σ_j repulsion·(p_i − p_j)/(|p_i − p_j|² + ε).
    const segs = segmentsOf([2, 3]);
    const g = buildGraph({ nodeCount: 5, source: [], target: [] });
    g.positions.set([0, 0, 1e-3, 0, 0, 0, 1e-3, 0, 0, 1e-3]);
    const params = { ...DEFAULT_FORCE, attraction: 0, centering: 0 };
    for (const frame of ["world", "unit"] as const) {
      const layout = new GpuForceLayout(device, { ...g, positions: g.positions.slice() }, params, { segments: segs, exactMax: 2, frame });
      layout.runFrame(1);
      const out = new Float32Array(10);
      layout.readForces(out);
      layout.destroy();
      segs.forEach((seg, s) => {
        const eps = segmentSoftening(frame, s === 0);
        for (let i = seg.start; i < seg.start + seg.count; i++) {
          let fx = 0, fy = 0;
          for (let j = seg.start; j < seg.start + seg.count; j++) {
            if (j === i) continue;
            const dx = (g.positions[i * 2] ?? 0) - (g.positions[j * 2] ?? 0);
            const dy = (g.positions[i * 2 + 1] ?? 0) - (g.positions[j * 2 + 1] ?? 0);
            const k = params.repulsion / (dx * dx + dy * dy + eps);
            fx += k * dx;
            fy += k * dy;
          }
          const err = Math.hypot((out[i * 2] ?? 0) - fx, (out[i * 2 + 1] ?? 0) - fy) / Math.hypot(fx, fy);
          expect(err, `${frame} frame, segment ${s}, slot ${i}`).toBeLessThan(2e-4);
        }
      });
    }
  });
});

describe("tiles vs the segmented reference (T3)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("per-node forces from identical positions: p99(r) ≤ 1e-4, ≤ 0.1% of nodes with r > 1e-2, over 5 ticks", () => {
    // Four segments in one region at exactMax 32: tiles of side 64, 32 and 16 at three different atlas
    // origins, and one exact segment. r_i = |ΔF_i| / (|F_i| + F_s) as in T5 (§9).
    const segments = segmentsOf([3000, 700, 150, 30]);
    const exactMax = 32;
    const graph = segmentedGraph(segments, [3000, 1500, 400, 200], 2, 0x7e5);
    const atlas = packTiles(segments, exactMax, TILE_MIN_SIDE);
    expect(atlas.tiles.map((t) => t && [t.x, t.y, t.side])).toEqual([[0, 0, 64], [64, 0, 32], [96, 0, 16], null]);
    const refSegments: ReferenceSegment[] = segments.map((seg, s) => {
      const tile = atlas.tiles[s] ?? null;
      return { ...seg, tileSide: tile?.side ?? null, softening: segmentSoftening("world", tile === null) };
    });
    const params = { ...DEFAULT_FORCE };
    const fs = params.repulsion / equilibriumSpacing(params);
    const csr = buildCSR(graph.nodeCount, graph.source, graph.target);
    const layout = new GpuForceLayout(device, graph, params, { segments, exactMax });
    const n = graph.nodeCount;
    const positions = new Float32Array(n * 2);
    const forces = new Float32Array(n * 2);
    const r = new Float64Array(n);
    let worstP99 = 0;
    let worstOutliers = 0;
    for (let tick = 0; tick < 5; tick++) {
      layout.readPositions(positions);
      layout.runFrame(1);
      layout.readForces(forces);
      const ref = segmentedReference(positions, n, csr, params, refSegments);
      let outliers = 0;
      for (let i = 0; i < n; i++) {
        const dx = (forces[i * 2] ?? 0) - (ref[i * 2] ?? 0);
        const dy = (forces[i * 2 + 1] ?? 0) - (ref[i * 2 + 1] ?? 0);
        r[i] = Math.hypot(dx, dy) / (Math.hypot(ref[i * 2] ?? 0, ref[i * 2 + 1] ?? 0) + fs);
        if ((r[i] ?? 0) > 1e-2) outliers++;
      }
      r.sort();
      const p99 = r[Math.floor(0.99 * n)] ?? 0;
      worstP99 = Math.max(worstP99, p99);
      worstOutliers = Math.max(worstOutliers, outliers);
      expect(p99, `tick ${tick}: p99(r)`).toBeLessThanOrEqual(1e-4);
      expect(outliers, `tick ${tick}: nodes with r > 1e-2`).toBeLessThanOrEqual(Math.floor(0.001 * n));
    }
    console.log(`  T3 tiles vs reference (N=${n}, 4 segments, 5 ticks): worst p99(r)=${worstP99.toExponential(2)}, worst outliers=${worstOutliers}/${n}`);
    layout.destroy();
  });
});
