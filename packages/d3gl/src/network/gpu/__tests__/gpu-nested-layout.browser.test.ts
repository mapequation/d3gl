/**
 * The batched GPU nested layout (#355, spec §11.1) against its float64 Jacobi reference, and the CPU
 * nested layout's invariants on its output.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Device, Framebuffer, FramebufferProps, Texture, TextureProps } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { NestedJacobiReference } from "./nested-jacobi-reference.js";
import { GpuNestedLayout, nestedLayoutPlan } from "../gpu-nested-layout.js";
import { nestedSolverResult, nestedSolverTopology, type NestedSolverTopology } from "../nested-topology.js";
import { NESTED, nestedLayout, type NestedLayoutParams, type NestedLayoutResult, type NestedLayoutTopology } from "../../nested-layout.js";
import {
  directedPartition,
  expectContained,
  expectNested,
  kids,
  linkTightness,
  meanShift,
  reclustered,
  rootOf,
  similar,
  spreadOf,
  threeLevel,
  topo,
  twoLevel,
  worstSeparation,
} from "../../__tests__/nested-fixtures.js";
import { COLLISION_RELAX, COLLISION_STEPS } from "../passes/collision.js";

/** Minimal seeded LCG PRNG. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

/**
 * A module tree over `groups` bottom modules (their leaf counts) under `tops` top modules (round-robin),
 * under one root, with `linksPerChild` random sibling super-edges per child at every level, and a
 * heavy-tailed leaf size metric. Children have lower ids than their parents.
 */
function makeTree(groups: readonly number[], tops: number, linksPerChild: number, seed = 7): { topo: NestedLayoutTopology; size: Float32Array } {
  const rnd = makePrng(seed);
  const leaves = groups.reduce((a, b) => a + b, 0);
  const bottom = groups.length;
  const size = leaves + bottom + tops + 1;
  const root = size - 1;
  const parent = new Int32Array(size).fill(-1);
  let leaf = 0;
  groups.forEach((n, g) => {
    for (let j = 0; j < n; j++) parent[leaf++] = leaves + g;
    parent[leaves + g] = leaves + bottom + (g % tops);
  });
  for (let t = 0; t < tops; t++) parent[leaves + bottom + t] = root;
  const childCount = new Uint32Array(size);
  for (let g = 0; g < size; g++) {
    const p = parent[g] ?? -1;
    if (p >= 0) childCount[p] = (childCount[p] ?? 0) + 1;
  }
  const childOffset = new Uint32Array(size + 1);
  for (let g = 0; g < size; g++) childOffset[g + 1] = (childOffset[g] ?? 0) + (childCount[g] ?? 0);
  const children = new Uint32Array(childOffset[size] ?? 0);
  const cursor = childOffset.slice(0, size);
  for (let g = 0; g < size; g++) {
    const p = parent[g] ?? -1;
    if (p < 0) continue;
    children[cursor[p] ?? 0] = g;
    cursor[p] = (cursor[p] ?? 0) + 1;
  }
  const out: number[][] = Array.from({ length: size }, () => []);
  for (let g = leaves; g < size; g++) {
    const k = childCount[g] ?? 0;
    if (k < 2) continue;
    const first = childOffset[g] ?? 0;
    for (let e = 0; e < k * linksPerChild; e++) {
      const a = children[first + Math.floor(rnd() * k)] ?? 0;
      const b = children[first + Math.floor(rnd() * k)] ?? 0;
      if (a !== b) out[a]?.push(b);
    }
  }
  const superEdgeOffset = new Uint32Array(size + 1);
  for (let g = 0; g < size; g++) superEdgeOffset[g + 1] = (superEdgeOffset[g] ?? 0) + (out[g]?.length ?? 0);
  const superEdgeTarget = new Uint32Array(superEdgeOffset[size] ?? 0);
  const superEdgeFlow = new Float32Array(superEdgeOffset[size] ?? 0);
  let p = 0;
  for (let g = 0; g < size; g++) {
    for (const t of out[g] ?? []) {
      superEdgeTarget[p] = t;
      superEdgeFlow[p++] = rnd();
    }
  }
  const metric = new Float32Array(leaves);
  for (let i = 0; i < leaves; i++) metric[i] = Math.pow(rnd() + 1e-3, -1.5);
  return { topo: { size, leafCount: leaves, childOffset, children, parent, superEdgeOffset, superEdgeTarget, superEdgeFlow }, size: metric };
}

/** Run `ticks` solve ticks of `layout`, every item unsliced. */
function runAll(layout: GpuNestedLayout, ticks: number): void {
  layout.runTicks(ticks);
}

/** Largest |a − b| over two arrays. */
function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m;
}

describe("GPU nested layout (#355) against its Jacobi reference", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  /**
   * GPU and reference after every tick of `ticks`, compared on the slots' local positions. With `restart`,
   * the reference starts each tick from the GPU's own positions and velocities, so each tick is compared
   * alone and float32 rounding does not compound across ticks.
   */
  function compareTicks(topo: NestedSolverTopology, ticks: number, organise?: number, restart = false): number {
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(topo), organise === undefined ? {} : { organise });
    const ref = new NestedJacobiReference(topo, organise);
    const local = new Float32Array(2 * topo.slotCount);
    const vel = new Float32Array(2 * topo.slotCount);
    const want = new Float64Array(2 * topo.slotCount);
    let worst = 0;
    try {
      for (let t = 0; t < ticks; t++) {
        if (restart && t > 0) {
          layout.readLocal(local);
          layout.readVelocity(vel);
          for (let i = 0; i < topo.slotCount; i++) {
            ref.x[i] = local[2 * i] ?? 0;
            ref.y[i] = local[2 * i + 1] ?? 0;
            ref.vx[i] = vel[2 * i] ?? 0;
            ref.vy[i] = vel[2 * i + 1] ?? 0;
          }
        }
        runAll(layout, 1);
        ref.step();
        layout.readLocal(local);
        for (let i = 0; i < topo.slotCount; i++) {
          want[2 * i] = ref.x[i] ?? 0;
          want[2 * i + 1] = ref.y[i] ?? 0;
        }
        worst = Math.max(worst, maxDiff(local, want));
      }
    } finally {
      layout.destroy();
    }
    return worst;
  }

  it("matches the reference tick for tick while every segment takes the exact loop (≤ 32 children)", () => {
    const { topo, size } = makeTree([6, 12, 3, 30, 1, 9, 20, 2], 3, 3);
    const solver = nestedSolverTopology(topo, { size, iterations: 30 });
    expect(Math.max(...solver.segCount)).toBeLessThanOrEqual(32);
    // Both phases: 18 organise ticks (repulsion, zero-rest springs) and 12 compact ticks (rest springs, collision).
    expect(compareTicks(solver, 30)).toBeLessThan(2e-5);
  });

  it("finds every colliding pair through the grid: a heavy-tailed 600-child segment matches the exact reference", () => {
    // No organise phase, so no Barnes-Hut: springs, integration and collision only, all exact-comparable.
    // Each tick is compared from the GPU's own state: in this dense pack the float64 reference itself
    // amplifies a 1e-9 displacement about 1e4-fold over the 12 ticks (a small disc wedged among several
    // larger ones), so free-running float32 and float64 solves drift apart whatever the grid finds.
    const { topo, size } = makeTree([600, 45, 90], 1, 2, 11);
    const solver = nestedSolverTopology(topo, { size, iterations: 12 });
    expect(Math.max(...solver.segCount)).toBe(600);
    expect(solver.segLarge.some((s) => s >= 0)).toBe(true); // large slots exist
    expect(compareTicks(solver, 12, 0, true)).toBeLessThan(2e-5);
  });

  it("a collision step keeps each segment's mass-weighted centre where the integration put it", () => {
    const { topo, size } = makeTree([400, 50], 1, 0, 3); // no links: gravity only, then collision
    const solver = nestedSolverTopology(topo, { size, iterations: 10 });
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver), { organise: 0 });
    try {
      runAll(layout, 1);
      const local = new Float32Array(2 * solver.slotCount);
      layout.readLocal(local);
      // Tick 0 at alpha 1: v' = −x · G · (1 − DECAY), x1 = x0 · (1 − 0.6 · G); collision conserves Σ m x.
      const shrink = 1 - (1 - NESTED.DECAY) * NESTED.GRAVITY;
      solver.segStart.forEach((start, s) => {
        const k = solver.segCount[s] ?? 0;
        let mx = 0;
        let my = 0;
        let want = 0;
        let wantY = 0;
        let mass = 0;
        for (let i = start; i < start + k; i++) {
          const m = (solver.radius[i] ?? 0) ** 2;
          mx += m * (local[2 * i] ?? 0);
          my += m * (local[2 * i + 1] ?? 0);
          want += m * (solver.seed[2 * i] ?? 0) * shrink;
          wantY += m * (solver.seed[2 * i + 1] ?? 0) * shrink;
          mass += m;
        }
        if (k < 2) return; // a lone (FROZEN) child has no collision partner, and a zero radius
        expect(Math.abs(mx - want) / mass).toBeLessThan(1e-5);
        expect(Math.abs(my - wantY) / mass).toBeLessThan(1e-5);
      });
    } finally {
      layout.destroy();
    }
  });

  it("separates an exactly coincident pair along the index direction (#357), on the grid and the exact path", () => {
    for (const k of [40, 8]) {
      const { topo, size } = makeTree([k], 1, 0, 5);
      const base = nestedSolverTopology(topo, { size, iterations: 10 });
      // Spread the children on a wide lattice (out of reach), then put slots a and b on one point.
      const seed = base.seed.slice();
      const radius = base.radius.slice().fill(0.01);
      const s = base.segStart[base.segStart.length - 1] ?? 0; // the bottom module's segment (deepest)
      const seg = base.segStart.findIndex((start, i) => (base.segCount[i] ?? 0) === k);
      const first = base.segStart[seg] ?? s;
      for (let i = 0; i < k; i++) {
        seed[2 * (first + i)] = (i % 8) * 0.2 - 0.7;
        seed[2 * (first + i) + 1] = Math.floor(i / 8) * 0.2 - 0.5;
      }
      const a = first + 2;
      const b = first + 5;
      seed[2 * b] = seed[2 * a] ?? 0;
      seed[2 * b + 1] = seed[2 * a + 1] ?? 0;
      radius[a] = 0.05;
      radius[b] = 0.1;
      const solver: NestedSolverTopology = { ...base, seed, radius, segR9: base.segR9.slice().fill(0.01), segLarge: base.segLarge.slice().fill(-1) };
      const large = solver.segLarge;
      if (k > 32) {
        // The two big discs are the segment's large slots (radius above r₉ = 0.01).
        large[seg * 8] = a;
        large[seg * 8 + 1] = b;
      }
      const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver), { organise: 0 });
      try {
        runAll(layout, 1);
        const local = new Float32Array(2 * solver.slotCount);
        layout.readLocal(local);
        const dx = (local[2 * b] ?? 0) - (local[2 * a] ?? 0);
        const dy = (local[2 * b + 1] ?? 0) - (local[2 * a + 1] ?? 0);
        const min = (0.05 + 0.1) * NESTED.PAD;
        // Each Jacobi step closes RELAX of the remaining gap: 1 − (1 − RELAX)^steps of min after one tick.
        expect(Math.hypot(dx, dy), `k = ${k}`).toBeCloseTo((1 - (1 - COLLISION_RELAX) ** COLLISION_STEPS) * min, 5);
        const ang = (a - first) + (b - first);
        expect(dx / Math.hypot(dx, dy)).toBeCloseTo(Math.cos(ang), 4);
        expect(dy / Math.hypot(dx, dy)).toBeCloseTo(Math.sin(ang), 4);
      } finally {
        layout.destroy();
      }
    }
  });

  it("is bitwise independent of how its stream ticks are cut into bands (repulsion and collision gathers)", () => {
    const { topo: tree, size } = makeTree([600, 45, 90, 12], 2, 2, 13);
    const solver = nestedSolverTopology(tree, { size, iterations: 20 });
    const whole = new GpuNestedLayout(device, nestedLayoutPlan(solver));
    const sliced = new GpuNestedLayout(device, nestedLayoutPlan(solver));
    try {
      whole.runTicks(solver.iterations);
      for (let t = 0; t < sliced.streamTicks; t++) {
        const bands = 1 + (t % 5); // 1 … 5 bands, a different cut every stream tick
        sliced.beginTick();
        for (let b = 0; b < bands; b++) sliced.forceBand(b, bands);
        sliced.integrate();
      }
      expect(sliced.ticks).toBe(solver.iterations);
      const a = new Float32Array(2 * solver.slotCount);
      const b = new Float32Array(2 * solver.slotCount);
      whole.readLocal(a);
      sliced.readLocal(b);
      expect(Array.from(b)).toEqual(Array.from(a));
    } finally {
      whole.destroy();
      sliced.destroy();
    }
  });

  it("frees every texture and framebuffer it created when its construction fails partway, and on destroy", () => {
    const solver = nestedSolverTopology(makeTree([40, 50, 60], 1, 1).topo, { iterations: 10 });
    const created: (Texture | Framebuffer)[] = [];
    const createTexture = device.createTexture.bind(device);
    const createFramebuffer = device.createFramebuffer.bind(device);
    let fbos = 0;
    let failAt = 0; // 0: never
    device.createTexture = (props: TextureProps): Texture => {
      const t = createTexture(props);
      created.push(t);
      return t;
    };
    device.createFramebuffer = (props: FramebufferProps): Framebuffer => {
      if (++fbos === failAt) throw new Error("injected: the device refused a framebuffer");
      const f = createFramebuffer(props);
      created.push(f);
      return f;
    };
    try {
      // The framebuffers the constructor creates itself come first: the two position FBOs, the four
      // integrate MRTs, v* and force. Fail at the first (after the four ping-pong textures) and at force's.
      for (const k of [1, 8]) {
        created.length = 0;
        fbos = 0;
        failAt = k;
        expect(() => new GpuNestedLayout(device, nestedLayoutPlan(solver))).toThrow(/injected/);
        expect(created.length, `resources created before framebuffer ${k}`).toBeGreaterThanOrEqual(k + 3);
        expect(created.filter((r) => !r.destroyed).length, `resources left alive after a failure at framebuffer ${k}`).toBe(0);
      }
      created.length = 0;
      failAt = 0;
      new GpuNestedLayout(device, nestedLayoutPlan(solver)).destroy();
      expect(created.length).toBeGreaterThan(20);
      expect(created.filter((r) => !r.destroyed).length, "resources left alive by destroy()").toBe(0);
    } finally {
      device.createTexture = createTexture;
      device.createFramebuffer = createFramebuffer;
    }
  });

  it("composes like the reference: leaves and module discs in world units", () => {
    const { topo: tree, size } = makeTree([6, 12, 3, 30, 1, 9, 20, 2], 3, 3);
    const solver = nestedSolverTopology(tree, { size, iterations: 30 });
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver));
    const ref = new NestedJacobiReference(solver);
    try {
      runAll(layout, 30);
      for (let t = 0; t < 30; t++) ref.step();
      const positions = new Float32Array(2 * solver.leafCount);
      const discs = new Float32Array(4 * (solver.treeSize - solver.leafCount));
      layout.readComposed(positions, discs);
      const want = ref.compose();
      const R = solver.rootRadius;
      for (let i = 0; i < solver.leafCount; i++) {
        expect(Math.abs((positions[2 * i] ?? 0) - (want.cx[i] ?? 0)) / R).toBeLessThan(1e-4);
        expect(Math.abs((positions[2 * i + 1] ?? 0) - (want.cy[i] ?? 0)) / R).toBeLessThan(1e-4);
      }
      for (let m = 0; m < solver.treeSize - solver.leafCount; m++) {
        const g = solver.leafCount + m;
        expect(Math.abs((discs[4 * m] ?? 0) - (want.cx[g] ?? 0)) / R).toBeLessThan(1e-4);
        expect(Math.abs((discs[4 * m + 1] ?? 0) - (want.cy[g] ?? 0)) / R).toBeLessThan(1e-4);
        expect(Math.abs((discs[4 * m + 2] ?? 0) - (want.r[g] ?? 0)) / R).toBeLessThan(1e-4);
      }
    } finally {
      layout.destroy();
    }
  });
});

describe("GPU nested layout (#355): the CPU layout's invariants and behaviour on its output", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  /**
   * A GPU nested layout in the CPU `nestedLayout`'s result shape: leaf positions and every tree node's
   * disc. The leaves' radii (the composition packs positions only) come from composing the GPU's own
   * local solution with the float64 reference, scaled like the rest by a warm start's placement.
   */
  function gpuNested(tree: NestedLayoutTopology, params: NestedLayoutParams = {}): NestedLayoutResult {
    const solver = nestedSolverTopology(tree, params);
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver));
    try {
      runAll(layout, solver.iterations);
      const positions = new Float32Array(2 * solver.leafCount);
      const discs = new Float32Array(4 * (solver.treeSize - solver.leafCount));
      layout.readComposed(positions, discs);
      const ref = new NestedJacobiReference(solver);
      const local = new Float32Array(2 * solver.slotCount);
      layout.readLocal(local);
      for (let i = 0; i < solver.slotCount; i++) {
        ref.x[i] = local[2 * i] ?? 0;
        ref.y[i] = local[2 * i + 1] ?? 0;
      }
      const leafDiscs = ref.compose();
      const out = nestedSolverResult(solver, positions, discs, params.initial, params.radius === undefined);
      const scale = (out.r[solver.root] ?? 0) / solver.rootRadius;
      for (let i = 0; i < solver.leafCount; i++) out.r[i] = (leafDiscs.r[i] ?? 0) * scale;
      return out;
    } finally {
      layout.destroy();
    }
  }

  describe("a two-level map (the CPU test's)", () => {
    const { tree, nodeCount } = twoLevel();
    const root = rootOf(tree);
    const [m1 = 0, m2 = 0, m3 = 0, m4 = 0] = kids(tree, root).sort((a, b) => a - b);

    it("keeps children inside parents, siblings apart, and linked siblings closer", () => {
      const out = gpuNested(topo(tree));
      expect(out.positions).toHaveLength(2 * nodeCount);
      expectNested(tree, out);
      const dist = (a: number, b: number): number => Math.hypot((out.cx[a] ?? 0) - (out.cx[b] ?? 0), (out.cy[a] ?? 0) - (out.cy[b] ?? 0));
      expect(dist(m1, m2)).toBeLessThan(dist(m1, m4));
      expect(dist(m3, m4)).toBeLessThan(dist(m2, m3));
    });

    it("sizes discs by the size metric", () => {
      const size = new Float32Array(nodeCount).fill(1);
      for (let j = 0; j < 6; j++) size[j] = 10;
      const out = gpuNested(topo(tree), { size });
      expect((out.r[m1] ?? 0) / (out.r[m2] ?? 1)).toBeCloseTo(Math.sqrt(10), 1);
    });

    it("is deterministic on one device: two runs are bitwise equal", () => {
      expect(Array.from(gpuNested(topo(tree)).positions)).toEqual(Array.from(gpuNested(topo(tree)).positions));
    });
  });

  it("keeps a directed partition's small hubs bounded: finite and O(1) every tick, nested, links as tight as the CPU's", () => {
    // web-NotreDame's directed Infomap tree went non-finite here: a low-flow hub's disc is no larger than
    // its neighbours', so it takes half or more of each link's correction, its summed share D grows with
    // its degree, and the Jacobi springs overshot (see NESTED_SPRING_GAIN_MAX). The fixture's hubs are
    // that shape (D ≈ 38, and two linked hubs).
    const { tree, flow } = directedPartition();
    const solver = nestedSolverTopology(topo(tree), { size: flow });
    /** Largest |local coordinate| over every tick of a GPU solve of `t`, and whether every tick stayed finite. */
    const run = (t: NestedSolverTopology): { peak: number; finite: boolean } => {
      const layout = new GpuNestedLayout(device, nestedLayoutPlan(t));
      const local = new Float32Array(2 * t.slotCount);
      let peak = 0;
      let finite = true;
      try {
        for (let tick = 0; tick < t.iterations; tick++) {
          runAll(layout, 1);
          layout.readLocal(local);
          for (const v of local) {
            if (!Number.isFinite(v)) finite = false;
            else peak = Math.max(peak, Math.abs(v));
          }
        }
      } finally {
        layout.destroy();
      }
      return { peak, finite };
    };
    const relaxed = run(solver);
    expect(relaxed.finite).toBe(true);
    expect(relaxed.peak, "local coordinates are the unit disc").toBeLessThan(2);
    // The control: the same tree with the springs unrelaxed overflows float32, as web-NotreDame's did.
    expect(run({ ...solver, springScale: new Float32Array(solver.slotCount).fill(1) }).finite).toBe(false);
    // The layout's invariants, held to the CPU layout's own result on the tree: its 151-child module packs
    // tiny discs pulled toward one hub, and the CPU leaves siblings overlapping there too (0.84 of the
    // radius sum), as on the heavy-tailed map below.
    const out = gpuNested(topo(tree), { size: flow });
    const cpu = nestedLayout(topo(tree), { size: flow });
    expectContained(tree, out);
    expect(worstSeparation(tree, out)).toBeGreaterThanOrEqual(worstSeparation(tree, cpu) - 0.02);
    const tight = linkTightness(tree, cpu);
    expect(linkTightness(tree, out), `the CPU's ${tight.toFixed(3)}`).toBeLessThan(tight + 0.02);
  });

  it("keeps the invariants on a three-level map whose bottom modules take the tile and grid paths (50 children)", () => {
    const tree = threeLevel(10, 12, 50);
    expectNested(tree, gpuNested(topo(tree)));
  });

  describe("warm starts (#328)", () => {
    const tree = threeLevel(12, 6, 10);
    const R = 10 * Math.sqrt(tree.leafCount);
    let cold: NestedLayoutResult;
    beforeAll(() => {
      cold = gpuNested(topo(tree));
    });

    it("moves nodes little from its own layout, and keeps the map's centroid and spread", () => {
      const warm = gpuNested(topo(tree), { initial: cold.positions });
      expect(meanShift(warm.positions, cold.positions)).toBeLessThan(0.06 * R);
      expectNested(tree, warm);
      const moved = similar(cold.positions, 1, 0.3, 500, -300);
      const before = spreadOf(moved);
      const after = spreadOf(gpuNested(topo(tree), { initial: moved }).positions);
      expect(after.x).toBeCloseTo(before.x, 1);
      expect(after.y).toBeCloseTo(before.y, 1);
      expect(after.rms / before.rms).toBeCloseTo(1, 4);
    });

    it("re-clusters: invariants hold, links pull as tight as the CPU's warm start, and it refines", () => {
      const { flat, merged, split } = reclustered();
      const before = gpuNested(topo(flat));
      const tightness: string[] = [];
      for (const next of [merged, split]) {
        const warm = gpuNested(topo(next), { initial: before.positions });
        const fresh = gpuNested(topo(next));
        const cpuWarm = nestedLayout(topo(next), { initial: before.positions });
        expectNested(next, warm);
        // The CPU test asks a warm start to pull links within 0.02 of a cold one (measured there: merged
        // 0.887 vs 0.906, split 0.922 vs 0.934). The GPU's Jacobi links pull a cold layout tighter than the
        // CPU's (measured: 0.84 on `merged`), so its warm start is held to the CPU's warm start instead.
        const t = linkTightness(next, warm);
        tightness.push(`${t.toFixed(3)} (cold ${linkTightness(next, fresh).toFixed(3)}, CPU warm ${linkTightness(next, cpuWarm).toFixed(3)})`);
        expect(t, tightness.join("; ")).toBeLessThan(linkTightness(next, cpuWarm) + 0.02);
        expect(meanShift(warm.positions, before.positions)).toBeLessThan(meanShift(fresh.positions, before.positions));
      }
    });
  });

  it("packs a heavy-tailed map no worse than the CPU layout (worst sibling distance over the radius sum)", () => {
    // Heavy-tailed radii leave overlaps in the CPU layout too (the radius floor is total / 50k): the GPU
    // is held to the CPU's own result on the same tree, not to the PAD tolerance.
    const { topo: tree, size } = makeTree([6, 120, 3, 300, 1, 45, 20, 2, 33, 70], 3, 3, 21);
    const worst = (out: Pick<NestedLayoutResult, "cx" | "cy" | "r">): number => {
      let w = Infinity;
      for (let g = tree.leafCount; g < tree.size; g++) {
        for (let a = tree.childOffset[g] ?? 0; a < (tree.childOffset[g + 1] ?? 0); a++) {
          for (let b = a + 1; b < (tree.childOffset[g + 1] ?? 0); b++) {
            const ca = tree.children[a] ?? 0;
            const cb = tree.children[b] ?? 0;
            const d = Math.hypot((out.cx[ca] ?? 0) - (out.cx[cb] ?? 0), (out.cy[ca] ?? 0) - (out.cy[cb] ?? 0));
            w = Math.min(w, d / ((out.r[ca] ?? 0) + (out.r[cb] ?? 0)));
          }
        }
      }
      return w;
    };
    const gpu = gpuNested(tree, { size });
    const cpu = nestedLayout(tree, { size });
    expect(worst(gpu)).toBeGreaterThanOrEqual(worst(cpu) - 0.02);
  });
});
