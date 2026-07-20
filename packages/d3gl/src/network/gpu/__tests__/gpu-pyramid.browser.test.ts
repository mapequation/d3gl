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
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GridPyramid, chooseGrid } from "../passes/grid-pyramid.js";
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
    // The pyramid path rebuilds the pyramid every tick (bbox → scatter → mip
    // reduce) and traverses it — several extra render passes. All their level
    // textures, FBOs and the bbox target must be pre-created in the constructor,
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
