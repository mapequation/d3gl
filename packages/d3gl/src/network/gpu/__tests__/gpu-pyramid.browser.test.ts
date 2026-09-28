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

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device, Texture } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GridPyramid, chooseGrid } from "../passes/grid-pyramid.js";
import { SegmentedReduce } from "../passes/segmented-reduce.js";
import { SegmentTable } from "../segment-table.js";
import {
  FLAT_TILE_MIN_SIDE,
  TILE_MIN_SIDE,
  canonicalCover,
  coverDepth,
  flatSegments,
  packTiles,
  slotSegments,
  type SlotRange,
} from "../segments.js";
import { reduce2x2 } from "./grid-pyramid-reference.js";
import { packPositionsTexture, readbackRgbaFbo } from "../textures.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { buildGraph } from "../../graph.js";
import { BarnesHutTree } from "../../quadtree.js";
import type { LayoutGraph } from "../../force.js";

/** DAMPING mirrored from gpu-force-layout.ts (private constant). */
const DAMPING = 0.9;

/**
 * Recover per-node repulsion force from a single tick's position delta.
 *
 * With attraction=0, centering=0 and zero initial velocity, the integrator does
 *   v' = clamp((0 + f·α)·damping, ±maxStep);  p' = p + v'
 * so (below the maxStep clamp) displacement = f·α·damping ⇒ f = Δp / (α·damping).
 * Runs exactly ONE tick from a fresh layout so velocity is zero on entry.
 */
function repulsionForces(
  device: Device,
  graph: LayoutGraph,
  repulsion: number,
  theta: number,
  mode: "allpairs" | "pyramid",
  alpha: number,
): Float32Array {
  const g: LayoutGraph = {
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    source: graph.source,
    target: graph.target,
    positions: graph.positions.slice(),
  };
  const p0 = g.positions.slice();
  const layout = new GpuForceLayout(
    device,
    g,
    { repulsion, attraction: 0, centering: 0, alpha, theta },
    { repulsionMode: mode },
  );
  layout.runFrame(1);
  const p1 = new Float32Array(graph.nodeCount * 2);
  layout.readPositions(p1);
  layout.destroy();

  const f = new Float32Array(graph.nodeCount * 2);
  const k = 1 / (alpha * DAMPING);
  for (let i = 0; i < f.length; i++) f[i] = (p1[i]! - p0[i]!) * k;
  return f;
}

/** A built tile pyramid, the segment table it was built from, and a cleanup for both. */
interface BuiltPyramid {
  pyramid: GridPyramid;
  table: SegmentTable;
  release(): void;
}

/**
 * Build the tile pyramid over `positions` the way the solver does: each segment's box comes from the
 * segmented range query, and every segment above `exactMax` gets a tile (the default: one flat
 * segment, always tiled). Returns the pyramid, the table and a cleanup for everything the build
 * allocated.
 */
function buildPyramid(
  device: Device,
  positions: Float32Array,
  segments: readonly SlotRange[] = flatSegments(positions.length / 2),
  exactMax = 0,
  beforeBuild?: (pyramid: GridPyramid) => void,
): BuiltPyramid {
  const count = positions.length / 2;
  const single = segments.length === 1;
  const atlas = packTiles(segments, exactMax, single ? FLAT_TILE_MIN_SIDE : TILE_MIN_SIDE);
  const { texture: posTex, width } = packPositionsTexture(device, positions);
  const { texture: velTex } = packPositionsTexture(device, new Float32Array(positions.length));
  const param = { repulsion: 0, centering: 0, softening: 0, alpha0: 1 };
  const table = new SegmentTable(device, segments.map((seg, s) => ({ ...seg, tile: atlas.tiles[s] ?? null, param })));
  const reduce = new SegmentedReduce(device, count);
  reduce.run({ pos: posTex, vel: velTex, posWidth: width, count }, table);
  let slotSeg: Texture | null = null;
  if (!single) {
    const ids = new Uint32Array(width * Math.ceil(count / width));
    ids.set(slotSegments(segments, count));
    slotSeg = device.createTexture({
      width, height: Math.ceil(count / width), format: "r32uint", data: ids, mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
  }
  const pyramid = new GridPyramid(device, atlas, single);
  beforeBuild?.(pyramid);
  pyramid.build({ posTex, width, count, segments: table, slotSeg });
  return {
    pyramid,
    table,
    release() {
      pyramid.destroy();
      reduce.destroy();
      table.destroy();
      slotSeg?.destroy();
      posTex.destroy();
      velTex.destroy();
    },
  };
}

/** Pyramid level `ℓ` read back as a `width × height × 4` array (its rectangle of its packed texture). */
function readLevel(device: Device, pyramid: GridPyramid, level: number): { data: Float32Array; width: number; height: number } {
  const lvl = pyramid.level(level);
  const tex = pyramid.textures[lvl.texture];
  const all = readbackRgbaFbo(device, tex);
  const data = new Float32Array(lvl.width * lvl.height * 4);
  for (let y = 0; y < lvl.height; y++) {
    const from = ((lvl.y + y) * tex.width + lvl.x) * 4;
    data.set(all.subarray(from, from + lvl.width * 4), y * lvl.width * 4);
  }
  return { data, width: lvl.width, height: lvl.height };
}

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

    const { pyramid, release } = buildPyramid(device, positions);

    // Root = last level (1×1 for the flat tile). Read (Σx, Σy, mass, 0).
    const root = readLevel(device, pyramid, pyramid.levelCount - 1).data; // length 4
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

    release();
  });

  it("mass is conserved across all pyramid levels (each level sums to count)", () => {
    const rng = makePrng(0xabcdef);
    const count = 500;
    const positions = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      positions[i * 2] = (rng() - 0.5) * 1000;
      positions[i * 2 + 1] = (rng() - 0.5) * 1000;
    }
    const { pyramid, release } = buildPyramid(device, positions);

    // Every level's total mass (Σ over all cells of channel 2) must equal count.
    for (let lvl = 0; lvl < pyramid.levelCount; lvl++) {
      const { data } = readLevel(device, pyramid, lvl);
      let totalMass = 0;
      for (let t = 0; t < data.length; t += 4) totalMass += data[t + 2]!;
      expect(totalMass).toBeCloseTo(count, 2);
    }

    release();
  });
});

/**
 * Build a graph of `count` nodes with random positions in a `spread`-wide box and
 * a sparse random edge set (edges don't affect repulsion — attraction is 0 in the
 * force tests below — but a valid CSR needs some structure).
 */
function makeRandomGraph(count: number, spread: number, seed: number): LayoutGraph {
  const rng = makePrng(seed);
  const src: number[] = [];
  const tgt: number[] = [];
  // ~1 edge per node so buildGraph/CSR is exercised; edges are irrelevant to
  // the repulsion-only comparison.
  for (let i = 0; i < count; i++) {
    src.push(i);
    tgt.push(Math.floor(rng() * count));
  }
  const g = buildGraph({ nodeCount: count, source: src, target: tgt });
  for (let i = 0; i < count; i++) {
    g.positions[i * 2] = (rng() - 0.5) * spread;
    g.positions[i * 2 + 1] = (rng() - 0.5) * spread;
  }
  return g;
}

describe("GPU Barnes-Hut pyramid repulsion — traversal correctness + perf (Step B)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("two unconnected nodes still repel with the pyramid path", () => {
    const g = buildGraph({ nodeCount: 2, source: [], target: [] });
    g.positions.set([0, 0, 1, 0]);
    const layout = new GpuForceLayout(
      device,
      g,
      { repulsion: 200, attraction: 0, centering: 0, alpha: 0.2, theta: 0.5 },
      { repulsionMode: "pyramid" },
    );
    layout.runFrame(60);
    const out = new Float32Array(4);
    layout.readPositions(out);
    // Nodes pushed apart (self-force at a shared/near leaf must not cancel it).
    expect(Math.hypot(out[2]! - out[0]!, out[3]! - out[1]!)).toBeGreaterThan(5);
    layout.destroy();
  });

  it("per-node repulsion force agrees with exact all-pairs within tolerance (θ≈0.5, 2000 nodes)", () => {
    // 2000 nodes → chooseGrid = 64 (G²=4096 leaf cells), so leaf cells average
    // ~0.5 nodes: most hold 0 or 1 node, a few hold ≥2. Where a leaf holds ≥2
    // nodes the pyramid lumps them (incl. the node's own softened self-term) into
    // one COM, whereas all-pairs treats each peer individually and excludes self.
    // That leaf-lumping — plus θ=0.5 opening-angle approximation on internal
    // cells — is the expected, documented source of divergence. We assert the
    // aggregate force fields agree closely, not exact equality.
    const count = 2000;
    const g = makeRandomGraph(count, 2000, 0x1234abcd);
    const repulsion = 200;
    const theta = 0.5;
    const alpha = 1e-4; // tiny → stays well below the maxStep clamp; linear regime

    const fExact = repulsionForces(device, g, repulsion, theta, "allpairs", alpha);
    const fBH = repulsionForces(device, g, repulsion, theta, "pyramid", alpha);

    // Relative L2 error of the whole force field: ‖fBH − fExact‖ / ‖fExact‖.
    let num = 0, den = 0, maxAbsErrRel = 0;
    for (let i = 0; i < count; i++) {
      const ex = fExact[i * 2]!, ey = fExact[i * 2 + 1]!;
      const bx = fBH[i * 2]!, by = fBH[i * 2 + 1]!;
      const dex = bx - ex, dey = by - ey;
      num += dex * dex + dey * dey;
      den += ex * ex + ey * ey;
      const mag = Math.hypot(ex, ey);
      if (mag > 1e-6) {
        const errRel = Math.hypot(dex, dey) / mag;
        if (errRel > maxAbsErrRel) maxAbsErrRel = errRel;
      }
    }
    const relL2 = Math.sqrt(num / den);
    console.log(`  BH vs all-pairs: relL2=${relL2.toFixed(4)} maxPerNodeRel=${maxAbsErrRel.toFixed(4)} (θ=${theta}, G=${chooseGrid(count)})`);

    // Aggregate field error at θ=0.5 is ≈0.24 (observed on SwiftShader). The
    // per-node MAX relative error can spike (a node whose exact force is nearly
    // zero has a tiny denominator), which is why we gate on the aggregate L2
    // field error, not the per-node max. Tolerance 0.35 leaves margin for
    // leaf-lumping (a leaf with ≥2 nodes is treated as one COM incl. the node's
    // own softened self-term) plus the θ opening-angle approximation.
    expect(relL2).toBeLessThan(0.35);
  });

  it("pyramid repulsion is ≥3× faster than all-pairs at a SwiftShader-feasible N", () => {
    // NOTE: browser tests run in headless Chromium on SwiftShader (software GL).
    // Absolute frame budgets ("1M under N ms") are NOT meaningful here and 1M is
    // too slow to run; real-GPU 1M frame-budget validation is done MANUALLY on
    // real hardware in Task 7 (the website example). This test asserts the
    // RELATIVE O(n²)→O(n log n) crossover at a feasible N with a generous margin.
    //
    // Robustness: SwiftShader wall-clock is noisy and this suite shares one page,
    // so a SINGLE timing sample can catch all-pairs in an unusually fast window
    // (observed once: a lone sample gave 0.98× while isolated runs gave ~6×). We
    // therefore take the MINIMUM over several repeats per mode — the min reflects
    // the true compute cost with the least transient interference, the right
    // statistic for a lower-bound speedup claim — and interleave the two modes so
    // both see similar accumulated device state.
    const count = 16000; // feasible for SwiftShader; O(n²) all-pairs = 256M terms/tick
    const ticks = 3;
    const repeats = 3;
    const g = makeRandomGraph(count, 4000, 0xfeedface);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const out = new Float32Array(count * 2);

    const time = (mode: "allpairs" | "pyramid"): number => {
      const gg: LayoutGraph = {
        nodeCount: g.nodeCount,
        edgeCount: g.edgeCount,
        source: g.source,
        target: g.target,
        positions: g.positions.slice(),
      };
      const layout = new GpuForceLayout(device, gg, params, { repulsionMode: mode });
      // Warm-up tick (shader compile / first-use costs) excluded from timing.
      layout.runFrame(1);
      const t0 = performance.now();
      layout.runFrame(ticks);
      // Force GPU completion before stopping the clock (readback is a sync fence).
      layout.readPositions(out);
      const dt = performance.now() - t0;
      layout.destroy();
      return dt;
    };

    let tAll = Infinity, tBH = Infinity;
    for (let r = 0; r < repeats; r++) {
      tAll = Math.min(tAll, time("allpairs"));
      tBH = Math.min(tBH, time("pyramid"));
    }
    const speedup = tAll / tBH;
    console.log(`  N=${count} ${ticks} ticks (best of ${repeats}): allpairs=${tAll.toFixed(1)}ms pyramid=${tBH.toFixed(1)}ms speedup=${speedup.toFixed(2)}×`);

    expect(speedup).toBeGreaterThanOrEqual(3);
  });

  it("pyramid ticking allocates no framebuffers or textures (all pre-created in the constructor)", () => {
    // The pyramid path rebuilds the pyramid every tick (segment reduction →
    // scatter → mip reduce) and traverses it — several extra render passes. All
    // their textures and FBOs must be pre-created in the constructor,
    // so ticking must create ZERO framebuffers AND ZERO textures. (The base spy
    // test only covers the all-pairs path; this guards the new hot path.)
    const g = makeRandomGraph(300, 1000, 0xbeef);
    const layout = new GpuForceLayout(
      device,
      g,
      { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 },
      { repulsionMode: "pyramid" },
    );

    const fboSpy = vi.spyOn(device, "createFramebuffer");
    const texSpy = vi.spyOn(device, "createTexture");
    layout.runFrame(10);
    expect(fboSpy).toHaveBeenCalledTimes(0);
    expect(texSpy).toHaveBeenCalledTimes(0);
    fboSpy.mockRestore();
    texSpy.mockRestore();
    layout.destroy();
  });
});

/** Build a LayoutGraph from explicit positions with a trivial ring edge list
 *  (edges are irrelevant here — attraction is 0 in the repulsion probes). */
function graphFromPositions(positions: Float32Array): LayoutGraph {
  const count = positions.length / 2;
  const src: number[] = [];
  const tgt: number[] = [];
  for (let i = 0; i < count; i++) {
    src.push(i);
    tgt.push((i + 1) % count);
  }
  const g = buildGraph({ nodeCount: count, source: src, target: tgt });
  g.positions.set(positions);
  return g;
}

describe("GPU pyramid level-0 near field — sub-cell clump probe (#251)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  // Shared probe geometry: 4 corner anchors pin the bbox to [-S, S]² so the
  // padded square box — and therefore the finest-cell geometry — is known in
  // closed form (same math as the scatter/traversal shaders: half = S·pad,
  // boxSide = 2·S·pad, cellSize = boxSide / G).
  const S = 2000;
  const PAD = 1.01; // GridPyramid.pad
  const G = 32;
  const LO = -S * PAD;
  const CELL = (2 * S * PAD) / G;

  /**
   * The #251 probe: a 100-node radius-2 clump placed at the centre of ONE
   * finest cell of a G=32 pyramid, plus background nodes (rejection-sampled
   * away from the clump's cell) so chooseGrid(count) = 32. The whole clump
   * fits inside a single level-0 cell (radius 2 ≪ cellSize/2 ≈ 63), which the
   * traversal force-accepts as one lumped COM at any distance.
   */
  function makeClumpProbe() {
    const clumpCount = 100;
    const clumpR = 2;
    const backgroundCount = 496; // 4 anchors + 496 + 100 = 600 → chooseGrid = 32
    const rng = makePrng(0x251251);

    // Clump centre = centre of finest cell (20, 16).
    const ccx = LO + (20 + 0.5) * CELL;
    const ccy = LO + (16 + 0.5) * CELL;

    const count = 4 + backgroundCount + clumpCount;
    const positions = new Float32Array(count * 2);
    let k = 0;
    const put = (x: number, y: number): void => {
      positions[k * 2] = x;
      positions[k * 2 + 1] = y;
      k++;
    };
    put(-S, -S); put(S, -S); put(-S, S); put(S, S);
    while (k < 4 + backgroundCount) {
      const x = (rng() * 2 - 1) * (S - 10);
      const y = (rng() * 2 - 1) * (S - 10);
      // Keep the clump's cell (and its immediate ring) free of bystanders so
      // the probed cell holds exactly the clump.
      if (Math.hypot(x - ccx, y - ccy) < 2 * CELL) continue;
      put(x, y);
    }
    const clumpStart = k;
    while (k < count) {
      const r = clumpR * Math.sqrt(rng());
      const a = 2 * Math.PI * rng();
      put(ccx + r * Math.cos(a), ccy + r * Math.sin(a));
    }
    return { positions, clumpStart, clumpCount, count };
  }

  it("clump force stays within a small factor of CPU BH both ways (θ=0.9)", () => {
    const { positions, clumpStart, clumpCount, count } = makeClumpProbe();
    expect(chooseGrid(count)).toBe(G);
    const g = graphFromPositions(positions);
    const repulsion = 200;
    const theta = 0.9;
    const alpha = 1e-4; // stays far below the maxStep clamp; linear regime

    // CPU BH reference: its adaptive quadtree resolves the clump members
    // individually at the leaves (exact pairwise inside the clump).
    const tree = new BarnesHutTree();
    tree.build(g.positions, count);
    const fx = new Float32Array(count);
    const fy = new Float32Array(count);
    for (let i = 0; i < count; i++) tree.applyForce(i, repulsion, theta, fx, fy);

    const fGpu = repulsionForces(device, g, repulsion, theta, "pyramid", alpha);

    let maxCpu = 0, maxGpu = 0, sumCpu = 0, sumGpu = 0;
    for (let i = clumpStart; i < clumpStart + clumpCount; i++) {
      const mc = Math.hypot(fx[i]!, fy[i]!);
      const mg = Math.hypot(fGpu[i * 2]!, fGpu[i * 2 + 1]!);
      if (mc > maxCpu) maxCpu = mc;
      if (mg > maxGpu) maxGpu = mg;
      sumCpu += mc;
      sumGpu += mg;
    }
    const ratioMax = maxGpu / maxCpu;
    const ratioMean = sumGpu / sumCpu;
    console.log(
      `  #251 clump probe: CPU max=${maxCpu.toFixed(0)} GPU max=${maxGpu.toFixed(0)} ` +
      `ratioMax=${ratioMax.toFixed(2)} ratioMean=${ratioMean.toFixed(2)}`,
    );

    // The un-softened lumped-COM 1/d kernel overestimated the clump ~3× vs CPU
    // BH (#251); the reverted cell-size resolution floor (#203) underestimated
    // it ~50×. The second-moment (mass/extent-aware) softening must stay
    // within a small factor BOTH ways.
    expect(ratioMax).toBeLessThanOrEqual(1.5);
    expect(ratioMax).toBeGreaterThanOrEqual(0.3);
  });

  it("well-separated regime (≤1 node/cell) is untouched: θ=0 forced level-0 accepts match all-pairs", () => {
    // One node per finest cell. θ=0 rejects every θ-acceptance, so the
    // traversal descends to level 0 and force-accepts EVERY occupied cell —
    // exactly the branch #251 modifies. With single occupants the cell's
    // second moment is exactly 0 (ε(1) = 0), so the level-0 term must remain
    // the plain point kernel and the field must equal the exact all-pairs
    // field up to float summation order.
    const rng = makePrng(0x977abc);
    const count = 600; // chooseGrid(600) = 32
    expect(chooseGrid(count)).toBe(G);

    const positions = new Float32Array(count * 2);
    positions.set([-S, -S, S, -S, -S, S, S, S]); // corner anchors pin the bbox
    const cells: Array<[number, number]> = [];
    for (let cy = 0; cy < G; cy++) for (let cx = 0; cx < G; cx++) cells.push([cx, cy]);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = cells[i]!;
      cells[i] = cells[j]!;
      cells[j] = t;
    }
    const isCornerCell = (cx: number, cy: number): boolean =>
      (cx === 0 || cx === G - 1) && (cy === 0 || cy === G - 1);
    let k = 4;
    for (const [cx, cy] of cells) {
      if (k >= count) break;
      if (isCornerCell(cx, cy)) continue; // the anchors already occupy these
      // Jitter ≪ cellSize/2 so nothing straddles a cell boundary.
      positions[k * 2] = LO + (cx + 0.5) * CELL + (rng() - 0.5) * CELL * 0.4;
      positions[k * 2 + 1] = LO + (cy + 0.5) * CELL + (rng() - 0.5) * CELL * 0.4;
      k++;
    }
    const g = graphFromPositions(positions);
    const alpha = 1e-4;

    const fExact = repulsionForces(device, g, 200, 0, "allpairs", alpha);
    const fBH = repulsionForces(device, g, 200, 0, "pyramid", alpha);

    let num = 0, den = 0;
    for (let i = 0; i < count * 2; i++) {
      const e = fBH[i]! - fExact[i]!;
      num += e * e;
      den += fExact[i]! * fExact[i]!;
    }
    const relL2 = Math.sqrt(num / den);
    console.log(`  #251 well-separated θ=0: relL2 vs all-pairs = ${relL2.toExponential(2)}`);

    // Pure float noise (summation order) is ≪ 1e-4; any softening leak into
    // single-occupant cells (ε(1) ≠ 0) would register orders of magnitude
    // above this (a cell-size floor shifts near-cell terms by ~50%).
    expect(relL2).toBeLessThan(1e-4);
  });
});

const EPS = 2 ** -23;

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
 * Positions for `segments` sharing one world region: segment `s` is a uniform square of side
 * `spreads[s]` around `centres[s]`, all overlapping around the origin — so a cross-segment leak would
 * land in the same cells, not in an empty corner.
 */
function sharedRegion(
  segments: readonly SlotRange[],
  spreads: readonly number[],
  centres: readonly (readonly [number, number])[],
  seed: number,
): Float32Array {
  const rng = makePrng(seed);
  const end = segments.reduce((n, s) => Math.max(n, s.start + s.count), 0);
  const pos = new Float32Array(end * 2);
  segments.forEach((seg, s) => {
    const spread = spreads[s] ?? 1000;
    const [cx, cy] = centres[s] ?? [0, 0];
    for (let i = seg.start; i < seg.start + seg.count; i++) {
      pos[i * 2] = cx + (rng() - 0.5) * spread;
      pos[i * 2 + 1] = cy + (rng() - 0.5) * spread;
    }
  });
  return pos;
}

describe("GPU tile pyramid — tiles and packed levels (T3)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  // exactMax 32: tiles of side 64, (exact), 64, 16 — the 16-tile lands at (0, 64) of a 128 × 128 atlas.
  const counts = [3000, 20, 1500, 200];
  const segments = segmentsOf(counts);
  const positions = sharedRegion(segments, [2000, 800, 500, 120], [[0, 0], [50, -40], [300, -200], [-150, 90]], 0x7e3);

  it("per-tile mass is conserved at every level (bitwise), and each tile root's COM matches its segment's stats", () => {
    const { pyramid, table, release } = buildPyramid(device, positions, segments, 32);
    const atlas = pyramid.atlas;
    expect(atlas.tiles.map((t) => t && [t.x, t.y, t.side])).toEqual([[0, 0, 64], null, [64, 0, 64], [0, 64, 16]]);
    const stats = readbackRgbaFbo(device, table.stats);
    const levels = atlas.levels.map((_, l) => readLevel(device, pyramid, l));

    // Nothing lands outside the tiles: level 0 holds exactly the tiled slots (the exact segment's are clipped).
    let total = 0;
    const l0 = levels[0];
    if (!l0) throw new Error("no level 0");
    for (let t = 2; t < l0.data.length; t += 4) total += l0.data[t] ?? 0;
    expect(total).toBe(3000 + 1500 + 200);

    atlas.tiles.forEach((tile, s) => {
      if (!tile) return;
      const seg = segments[s];
      if (!seg) throw new Error(`no segment ${s}`);
      const root = Math.log2(tile.side);
      let maxOccupancy = 0;
      let sumX = 0, sumY = 0, mass = 0;
      for (let l = 0; l <= root; l++) {
        const lvl = levels[l];
        if (!lvl) throw new Error(`no level ${l}`);
        sumX = 0; sumY = 0; mass = 0;
        for (let y = tile.y >> l; y < (tile.y + tile.side) >> l; y++) {
          for (let x = tile.x >> l; x < (tile.x + tile.side) >> l; x++) {
            const o = (y * lvl.width + x) * 4;
            sumX += lvl.data[o] ?? 0;
            sumY += lvl.data[o + 1] ?? 0;
            const m = lvl.data[o + 2] ?? 0;
            mass += m;
            if (l === 0) maxOccupancy = Math.max(maxOccupancy, m);
          }
        }
        // Integer sums below 2²⁴ are exact in float32, whatever the add order: bitwise.
        expect(mass, `segment ${s}, level ${l}`).toBe(seg.count);
      }
      // At the root the loop above read exactly one cell: the tile's totals.
      const n = stats[s * 4 + 3] ?? 0;
      expect(n).toBe(seg.count);
      let absX = 0, absY = 0;
      for (let i = seg.start; i < seg.start + seg.count; i++) {
        absX += Math.abs(positions[i * 2] ?? 0);
        absY += Math.abs(positions[i * 2 + 1] ?? 0);
      }
      // Combined bound of both add trees (§6.1, §9): the range query's cover depth plus the pyramid's
      // (the level-0 blend chain of the fullest cell, then 3 adds per reduce level), and a rounding for
      // each division.
      const depth = coverDepth(canonicalCover(seg.start, seg.count)) + maxOccupancy + 3 * root + 2;
      expect(Math.abs(sumX / mass - (stats[s * 4] ?? 0) / n)).toBeLessThanOrEqual((depth * EPS * absX) / n);
      expect(Math.abs(sumY / mass - (stats[s * 4 + 1] ?? 0) / n)).toBeLessThanOrEqual((depth * EPS * absY) / n);
    });
    release();
  });

  it("writing a packed level leaves the other levels of its texture unchanged (the clear rule, §6)", () => {
    // Fill Podd / Peven with a sentinel first, then snapshot both after every render pass of the build
    // ends (the scatter, then one reduce per level ℓ ≥ 1; the build does not submit, #402). The pass that writes
    // level ℓ may change only ℓ's rectangle: every other texel of both textures — levels ℓ ± 2 in the
    // same texture included — must be bitwise what it was before that pass. So no pass cleared its
    // texture (luma's default clear ignores the viewport) or wrote past its rectangle. After the
    // build every texel outside the rectangles still holds the sentinel, and every level is the 2×2
    // reduce of the level below.
    const SENTINEL = 12345.5;
    type Snapshot = Readonly<Record<"odd" | "even", Float32Array>>;
    for (const [segs, exactMax] of [[segmentsOf([5000]), 0], [segmentsOf([3000, 200]), 32]] as const) {
      const pos = sharedRegion(segs, [1500, 300], [[0, 0], [100, 100]], 0x5e17);
      const snapshots: Snapshot[] = [];
      let watched: GridPyramid | null = null;
      const snapshot = (p: GridPyramid): Snapshot => ({
        odd: readbackRgbaFbo(device, p.textures.odd),
        even: readbackRgbaFbo(device, p.textures.even),
      });
      const begin = device.beginRenderPass.bind(device);
      const spy = vi.spyOn(device, "beginRenderPass").mockImplementation((props) => {
        const pass = begin(props);
        const end = pass.end.bind(pass);
        pass.end = () => {
          end();
          if (watched) snapshots.push(snapshot(watched));
        };
        return pass;
      });
      let built: BuiltPyramid;
      try {
        built = buildPyramid(device, pos, segs, exactMax, (p) => {
          for (const tex of [p.textures.odd, p.textures.even]) {
            tex.writeData(new Float32Array(tex.width * tex.height * 4).fill(SENTINEL));
          }
          snapshots.push(snapshot(p));
          watched = p;
        });
      } finally {
        spy.mockRestore();
      }
      const { pyramid, release } = built;
      const atlas = pyramid.atlas;
      expect(atlas.levels.length).toBeGreaterThanOrEqual(5); // levels ℓ and ℓ ± 2 share a texture
      // The fill, the scatter, then one reduce per coarser level.
      expect(snapshots.length).toBe(atlas.levels.length + 1);
      for (let p = 1; p < snapshots.length; p++) {
        const before = snapshots[p - 1];
        const after = snapshots[p];
        if (!before || !after) throw new Error(`no snapshot around pass ${p - 1}`);
        // Pass 0 is the scatter (it writes L0 only); pass p ≥ 1 writes level p.
        const written = p === 1 ? null : pyramid.level(p - 1);
        for (const which of ["odd", "even"] as const) {
          const tex = pyramid.textures[which];
          const a = new Uint32Array(before[which].buffer);
          const b = new Uint32Array(after[which].buffer);
          let changed = 0;
          for (let y = 0; y < tex.height; y++) {
            for (let x = 0; x < tex.width; x++) {
              const inside = written !== null && written.texture === which &&
                x >= written.x && x < written.x + written.width && y >= written.y && y < written.y + written.height;
              if (inside) continue;
              const o = (y * tex.width + x) * 4;
              for (let ch = 0; ch < 4; ch++) if (a[o + ch] !== b[o + ch]) changed++;
            }
          }
          expect(changed, `pass ${p - 1} changed ${which} texels outside its level's rectangle`).toBe(0);
        }
      }
      for (const which of ["odd", "even"] as const) {
        const tex = pyramid.textures[which];
        const all = readbackRgbaFbo(device, tex);
        const rects = atlas.levels.filter((l) => l.texture === which);
        let untouched = 0;
        for (let y = 0; y < tex.height; y++) {
          for (let x = 0; x < tex.width; x++) {
            if (rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue;
            for (let ch = 0; ch < 4; ch++) expect(all[(y * tex.width + x) * 4 + ch]).toBe(SENTINEL);
            untouched++;
          }
        }
        expect(untouched).toBeGreaterThan(0); // the column leaves free texels: the check is not vacuous
      }
      for (let l = 1; l < atlas.levels.length; l++) {
        const below = readLevel(device, pyramid, l - 1);
        const lvl = readLevel(device, pyramid, l);
        const expected = reduce2x2(below.data, lvl.width, lvl.height);
        // A compiler may add a + b + c + d in another order than the reference's left fold. Two orders
        // of a 4-term float32 sum differ by at most ~3ε·Σ|term|, so the bound scales with the children's
        // magnitudes, not the result's: a 2×2 block straddling x = 0 (children +5 and −4) cancels.
        const magnitude = reduce2x2(below.data.map(Math.abs), lvl.width, lvl.height);
        for (let k = 0; k < expected.length; k++) {
          const e = expected[k] ?? 0;
          if (k % 4 === 2) expect(lvl.data[k], `level ${l} mass`).toBe(e); // integers: exact
          else expect(Math.abs((lvl.data[k] ?? 0) - e), `level ${l}`).toBeLessThanOrEqual(4 * EPS * (magnitude[k] ?? 0) + 1e-30);
        }
      }
      release();
    }
  });

  it("the feedback-loop probe (§6.2.3): a mipmap-filtered read of level ℓ with level ℓ + 1 attached is a loop; raw base/max clamps lift it", () => {
    const r = feedbackLoopProbe();
    console.log(`  §6.2.3 probe: ${JSON.stringify(r)}`);
    // (a) A mipmap filter samples every level in [base, max], so reading level 1 while level 2 is
    //     attached is a feedback loop: the draw is rejected.
    expect(r.mipFiltered.error).toBe(WebGL2RenderingContext.INVALID_OPERATION);
    // (c) TEXTURE_BASE_LEVEL = TEXTURE_MAX_LEVEL = 1 (raw GL; luma exposes neither) excludes level 2.
    expect(r.clamped.error).toBe(WebGL2RenderingContext.NO_ERROR);
    expect(r.clamped.sum).toBe(10);
    // (b) — a non-mipmap filter, where the sampled range is only the base level — is logged, not
    //     asserted: it ran with the correct sum on the devices measured for #354 (see the PR), but the
    //     filter-dependent range is ANGLE's reading of the rule, not a WebGL2 guarantee. Packed levels
    //     (Q2) depend on neither.
  });
});

/** One probe draw: the GL error it raised and the value it wrote into level 2. */
interface ProbeDraw {
  error: number;
  sum: number;
}

/**
 * §6.2.3's probe, in raw WebGL2 on its own context. The rejected alternative to packed levels reduces
 * level ℓ into level ℓ + 1 of ONE mip-mapped texture. Here: a 4×4 `rgba32f` texture with 3 levels,
 * level 1 = (1, 2, 3, 4), level 2 (1×1) attached, and a pass that sums level 1's 2×2 texels —
 * (a) through a mipmap filter at `texelFetch` lod 1, (b) through a non-mipmap filter at lod 1, and
 * (c) with raw `TEXTURE_BASE_LEVEL = TEXTURE_MAX_LEVEL = 1` at lod 0. luma sets none of the three
 * level parameters, so only (a) and (b) are reachable without a raw-GL seam.
 */
function feedbackLoopProbe(): { mipFiltered: ProbeDraw; nearestLod1: ProbeDraw; clamped: ProbeDraw } {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) throw new Error("probe: no WebGL2 float render targets");
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 3, gl.RGBA32F, 4, 4);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, 4, gl.RGBA, gl.FLOAT, new Float32Array(64));
  gl.texSubImage2D(gl.TEXTURE_2D, 1, 0, 0, 2, 2, gl.RGBA, gl.FLOAT, new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0]));
  gl.texSubImage2D(gl.TEXTURE_2D, 2, 0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 2);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("probe: incomplete FBO");
  const program = (lod: number): WebGLProgram => {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) throw new Error("probe: could not create the program");
    gl.shaderSource(vs, "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID&1)<<2),float((gl_VertexID&2)<<1))-1.0;gl_Position=vec4(p,0,1);}");
    gl.shaderSource(fs, `#version 300 es\nprecision highp float;uniform highp sampler2D u_src;out vec4 o;
      void main(){o=texelFetch(u_src,ivec2(0,0),${lod})+texelFetch(u_src,ivec2(1,0),${lod})+texelFetch(u_src,ivec2(0,1),${lod})+texelFetch(u_src,ivec2(1,1),${lod});}`);
    gl.compileShader(vs);
    gl.compileShader(fs);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`probe: link failed ${gl.getProgramInfoLog(prog)}`);
    return prog;
  };
  const lod1 = program(1);
  const lod0 = program(0);
  gl.viewport(0, 0, 1, 1);
  const draw = (prog: WebGLProgram): ProbeDraw => {
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    gl.clearColor(-1, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const error = gl.getError();
    const px = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
    return { error, sum: px[0] ?? Number.NaN };
  };
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
  const mipFiltered = draw(lod1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  const nearestLod1 = draw(lod1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 1);
  const clamped = draw(lod0);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { mipFiltered, nearestLod1, clamped };
}

/** Sampler types a fragment or vertex shader can declare in WebGL2. */
const SAMPLER_TYPES = new Set<GLenum>([
  WebGL2RenderingContext.SAMPLER_2D, WebGL2RenderingContext.INT_SAMPLER_2D, WebGL2RenderingContext.UNSIGNED_INT_SAMPLER_2D,
  WebGL2RenderingContext.SAMPLER_3D, WebGL2RenderingContext.SAMPLER_CUBE, WebGL2RenderingContext.SAMPLER_2D_ARRAY,
  WebGL2RenderingContext.INT_SAMPLER_3D, WebGL2RenderingContext.UNSIGNED_INT_SAMPLER_3D,
  WebGL2RenderingContext.INT_SAMPLER_2D_ARRAY, WebGL2RenderingContext.UNSIGNED_INT_SAMPLER_2D_ARRAY,
  WebGL2RenderingContext.SAMPLER_2D_SHADOW, WebGL2RenderingContext.SAMPLER_2D_ARRAY_SHADOW, WebGL2RenderingContext.SAMPLER_CUBE_SHADOW,
]);

/** The active sampler uniforms of every program that draws while `run` executes. */
function samplersPerProgram(run: () => void): string[][] {
  const proto = WebGL2RenderingContext.prototype;
  const orig = proto.drawArrays;
  const seen = new Map<WebGLProgram, string[]>();
  proto.drawArrays = function (this: WebGL2RenderingContext, mode: GLenum, first: GLint, count: GLsizei): void {
    const program: WebGLProgram | null = this.getParameter(this.CURRENT_PROGRAM);
    if (program && !seen.has(program)) {
      const names: string[] = [];
      const n: number = this.getProgramParameter(program, this.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = this.getActiveUniform(program, i);
        if (info && SAMPLER_TYPES.has(info.type)) names.push(info.name);
      }
      seen.set(program, names.sort());
    }
    orig.call(this, mode, first, count);
  };
  try {
    run();
  } finally {
    proto.drawArrays = orig;
  }
  return [...seen.values()];
}

describe("GPU tile pyramid — texture-unit budget (spec §6.2.5)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("every pass of a tick binds at most 11 samplers; the traversal needs 3 pyramid textures, not one per level", () => {
    const limit: number = document.createElement("canvas").getContext("webgl2")?.getParameter(WebGL2RenderingContext.MAX_TEXTURE_IMAGE_UNITS) ?? 16;
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const cases: { label: string; graph: LayoutGraph; segments?: SlotRange[]; exactMax?: number; traversal: number | null }[] = [
      // Flat pyramid: pos, segInfo, segParam, segBox, L0, Podd, Peven (the single-texture pyramid bound 13).
      { label: "flat pyramid", graph: makeRandomGraph(20_000, 4000, 0x71e5), traversal: 7 },
      { label: "flat exact", graph: makeRandomGraph(1000, 1000, 0x71e6), traversal: null },
      // Many segments add slotSeg.
      { label: "segmented, tiles + exact", graph: buildGraph({ nodeCount: 3220, source: [], target: [] }), segments: segmentsOf([3000, 20, 200]), exactMax: 32, traversal: 8 },
    ];
    for (const c of cases) {
      const layout = new GpuForceLayout(device, c.graph, params, {
        ...(c.segments ? { segments: c.segments } : {}),
        ...(c.exactMax !== undefined ? { exactMax: c.exactMax } : {}),
      });
      const programs = samplersPerProgram(() => layout.runFrame(1));
      layout.destroy();
      const counts = programs.map((p) => p.length);
      console.log(`  ${c.label}: samplers per program ${JSON.stringify(counts)}`);
      for (const p of programs) {
        expect(p.length, p.join(",")).toBeLessThanOrEqual(11);
        expect(p.length).toBeLessThanOrEqual(limit);
        expect(p.some((name) => name.startsWith("u_level")), p.join(",")).toBe(false);
      }
      const traversal = programs.find((p) => p.includes("u_L0"));
      if (c.traversal === null) {
        expect(traversal).toBeUndefined();
      } else {
        expect(traversal?.length, traversal?.join(",")).toBe(c.traversal);
      }
    }
  });
});
