/**
 * The GPU nested layout's handle (#355): streaming, one-frame warm starts, boundary discs, the worker
 * fallback, and `layout({ backend: "gpu", nested })` through the engine.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import { makeTestDevice } from "./_device.js";
import { AsyncPositionReadback } from "../async-readback.js";
import { startGpuNestedLayout } from "../gpu-nested-transport.js";
import { GpuNestedLayout, gpuNestedLayoutNeed, nestedLayoutPlan } from "../gpu-nested-layout.js";
import { nestedSolverResult, nestedSolverTopology } from "../nested-topology.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { nestedBoundaryDiscs, nestedLayout, type NestedLayoutTopology } from "../../nested-layout.js";
import type { BoundaryDiscs } from "../../lod.js";
import { network } from "../../network.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";
import { threeLevel, topo } from "../../__tests__/nested-fixtures.js";

/** A graph over the tree's leaves (leaf ids are node ids), with a ring of edges. */
function graphOver(tree: NestedLayoutTopology): NetworkGraph {
  const n = tree.leafCount;
  return buildGraph({ nodeCount: n, source: Array.from({ length: n }, (_, i) => i), target: Array.from({ length: n }, (_, i) => (i + 1) % n) });
}

/**
 * `T × S × L` leaves in `T` top modules of `S` bottom modules, **without links**. A bottom module of 33
 * leaves takes an 8 × 8 tile (64 texels for 33 slots), so the segments' tile atlas outgrows the slot
 * atlas: at `(10, 8, 33)`, 2,730 slots in a 53-texel slot atlas and a 128 × 64 tile atlas.
 */
function linklessThreeLevel(T: number, S: number, L: number): NestedLayoutTopology {
  const records: ModuleNode[] = [];
  for (let id = 0; id < T * S * L; id++) records.push({ id, path: [Math.floor(id / (S * L)) + 1, Math.floor((id % (S * L)) / L) + 1, (id % L) + 1] });
  return topo(buildModuleLODTree(T * S * L, records));
}

/**
 * 1,128 leaves, **without links**, in two top modules: one of 16 bottom modules of 33 leaves (an 8 × 8 tile
 * each, a 32 × 32 tile atlas), one of 20 bottom modules of 30 (the exact loop). 1,166 slots: a 35-texel
 * slot atlas, while the flat layout's grid estimate for as many nodes is 64 texels.
 */
function tiledAndExact(): NestedLayoutTopology {
  const records: ModuleNode[] = [];
  let id = 0;
  for (let b = 0; b < 16; b++) for (let l = 0; l < 33; l++) records.push({ id: id++, path: [1, b + 1, l + 1] });
  for (let b = 0; b < 20; b++) for (let l = 0; l < 30; l++) records.push({ id: id++, path: [2, b + 1, l + 1] });
  return topo(buildModuleLODTree(id, records));
}

/**
 * `n` leaves, each under a chain of two single-child modules: 3n slots in 2n + 1 segments, so the
 * large-slot table (two texels per segment row) is the largest texture the nested layout allocates.
 */
function singleChildChains(n: number): NestedLayoutTopology {
  const records: ModuleNode[] = [];
  for (let id = 0; id < n; id++) records.push({ id, path: [id + 1, 1, 1] });
  return topo(buildModuleLODTree(n, records));
}

/** A fresh WebGL2 test device that reports `max` as its `maxTextureDimension2D` (read before any probe). */
async function deviceWithTextureLimit(max: number): Promise<Device> {
  const device = await makeTestDevice();
  const limits = device.limits;
  const capped = new Proxy(limits, { get: (target, key) => (key === "maxTextureDimension2D" ? max : Reflect.get(target, key)) });
  Object.defineProperty(device, "limits", { configurable: true, value: capped });
  return device;
}

/** The direct solver's composed result on `device` — the reference the handle's output must equal bitwise. */
function direct(device: Device, tree: NestedLayoutTopology, iterations: number, initial?: Float32Array): ReturnType<typeof nestedSolverResult> {
  const solver = nestedSolverTopology(tree, { iterations, radius: initial ? undefined : 10 * Math.sqrt(tree.leafCount), initial });
  const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver));
  try {
    layout.runTicks(solver.iterations);
    const positions = new Float32Array(2 * solver.leafCount);
    const discs = new Float32Array(4 * (solver.treeSize - solver.leafCount));
    layout.readComposed(positions, discs);
    return nestedSolverResult(solver, positions, discs, initial, initial !== undefined);
  } finally {
    layout.destroy();
  }
}

describe("startGpuNestedLayout (#355)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tree = topo(threeLevel(6, 8, 40)); // bottom modules of 40 leaves: the tile and grid paths
  const iterations = 40;
  const radius = 10 * Math.sqrt(tree.leafCount);

  it("streams a cold layout as frames of all depths, then lands the direct solve's positions and discs", async () => {
    const g = graphOver(tree);
    let frames = 0;
    const got: { boundaries: BoundaryDiscs | null } = { boundaries: null };
    const handle = startGpuNestedLayout(device, g, tree, { iterations, radius }, () => frames++, {
      frameEvery: 10,
      onBoundaries: (discs) => {
        got.boundaries = discs;
      },
    });
    expect(handle.transport).toBe("pending"); // the prep runs in a worker first
    await handle.settled;
    expect(handle.transport).toBe("gpu");
    // One frame per 10 ticks (the final one included): all depths move together in each.
    expect(frames).toBeGreaterThanOrEqual(3);
    const want = direct(device, tree, iterations);
    expect(Array.from(g.positions)).toEqual(Array.from(want.positions));
    const wantDiscs = nestedBoundaryDiscs(tree, want);
    expect(got.boundaries).not.toBeNull();
    expect(Array.from(got.boundaries?.r ?? [])).toEqual(Array.from(wantDiscs.r));
    expect(Array.from(got.boundaries?.dx ?? [])).toEqual(Array.from(wantDiscs.dx));
  });

  it("reads a warm start back in one frame, placed over the current map, without touching the graph first", async () => {
    const g = graphOver(tree);
    const cold = nestedLayout(tree, { iterations, radius });
    g.positions.set(cold.positions);
    const initial = g.positions.slice();
    const before = g.positions.slice();
    let frames = 0;
    const got: { result: Float32Array | null } = { result: null };
    const handle = startGpuNestedLayout(device, g, tree, { iterations, initial }, () => frames++, {
      onResult: (positions) => {
        got.result = positions;
        // Still the old map when the result arrives: a transition eases from it.
        expect(Array.from(g.positions)).toEqual(Array.from(before));
      },
    });
    await handle.settled;
    expect(frames).toBe(0); // with onResult the caller lands it
    const want = direct(device, tree, iterations, initial);
    expect(got.result).not.toBeNull();
    expect(Array.from(got.result ?? [])).toEqual(Array.from(want.positions));
  });

  it("falls back to the worker with one warning when there is no device", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = graphOver(tree);
    const handle = startGpuNestedLayout(null, g, tree, { iterations, radius }, () => {});
    await handle.settled;
    expect(handle.transport).toBe("worker");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/fell back to the CPU worker/);
    // The worker runs the CPU layout itself.
    expect(Array.from(g.positions)).toEqual(Array.from(nestedLayout(tree, { iterations, radius }).positions));
  });

  it("falls back silently with warnUnsupported: false (\"auto\", #375) when there is no device", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = graphOver(tree);
    const handle = startGpuNestedLayout(null, g, tree, { iterations, radius }, () => {}, { warnUnsupported: false });
    await handle.settled;
    expect(handle.transport).toBe("worker");
    expect(warn).not.toHaveBeenCalled();
    expect(Array.from(g.positions)).toEqual(Array.from(nestedLayout(tree, { iterations, radius }).positions));
  });

  // A 64-texel device: the slot atlas (53), the CSR offsets (53) and the pre-prep grid estimate (64) fit,
  // so each case below reaches the check after the prep, where the segments and links are known.
  describe("a tree past the device's textures, found after the prep, is unsupported, not a failure (#375)", () => {
    const small = 64;
    let limited: Device;
    beforeAll(async () => {
      limited = await deviceWithTextureLimit(small);
    });

    const cases: [string, NestedLayoutTopology, RegExp][] = [
      ["the tile atlas (128 × 64)", linklessThreeLevel(10, 8, 33), /needs a 128-texel tile atlas texture, past the device's 64-texel limit/],
      ["the springs' CSR", topo(threeLevel(10, 8, 33)), /needs a \d+-texel spring texture, past the device's 64-texel limit/],
    ];
    it.each(cases)("%s: silent with warnUnsupported: false, one warning naming it without", async (_label, tree, reason) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const params = { iterations: 10, radius: 10 * Math.sqrt(tree.leafCount) };
      const want = nestedLayout(tree, params).positions;
      const auto = graphOver(tree);
      const handle = startGpuNestedLayout(limited, auto, tree, params, () => {}, { warnUnsupported: false });
      await handle.settled;
      expect(handle.transport).toBe("worker");
      expect(warn).not.toHaveBeenCalled();
      expect(Array.from(auto.positions)).toEqual(Array.from(want));

      const gpu = graphOver(tree);
      const warned = startGpuNestedLayout(limited, gpu, tree, params, () => {});
      await warned.settled;
      expect(warned.transport).toBe("worker");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.length, "an unsupported tree passes no error value").toBe(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(reason);
      expect(Array.from(gpu.positions)).toEqual(Array.from(want));
    });

    it("the verdict covers every texture the nested layout allocates", () => {
      for (const tree of [...cases.map(([, t]) => t), singleChildChains(500)]) {
        const solver = nestedSolverTopology(tree, { iterations: 10, radius: 10 * Math.sqrt(tree.leafCount) });
        const plan = nestedLayoutPlan(solver);
        const need = gpuNestedLayoutNeed(plan);
        const covered = Math.max(need.positionSide, need.offsetsSide, need.springSide, need.pyramidSide, need.nested?.largeSide ?? 0);
        const sides: number[] = [];
        const createTexture = vi.spyOn(device, "createTexture");
        const createFramebuffer = vi.spyOn(device, "createFramebuffer");
        const layout = new GpuNestedLayout(device, plan);
        try {
          for (const [props] of [...createTexture.mock.calls, ...createFramebuffer.mock.calls]) sides.push(props.width ?? 0, props.height ?? 0);
        } finally {
          layout.destroy();
          vi.restoreAllMocks();
        }
        expect(sides.length).toBeGreaterThan(0);
        expect(Math.max(...sides)).toBeLessThanOrEqual(covered);
      }
    });

    // Where the large-slot table is the largest texture, the largest side the layout allocates is the
    // need's large-slot side exactly: the verdict and the constructor size that table by one rule.
    it("names the large-slot table's exact side where it is the largest texture (single-child chains)", () => {
      const solver = nestedSolverTopology(singleChildChains(500), { iterations: 10, radius: 10 * Math.sqrt(500) });
      const plan = nestedLayoutPlan(solver);
      const need = gpuNestedLayoutNeed(plan);
      const large = need.nested?.largeSide ?? 0;
      expect(large).toBeGreaterThan(Math.max(need.positionSide, need.offsetsSide, need.springSide, need.pyramidSide));
      const sides: number[] = [];
      const createTexture = vi.spyOn(device, "createTexture");
      const layout = new GpuNestedLayout(device, plan);
      try {
        for (const [props] of createTexture.mock.calls) sides.push(props.width ?? 0, props.height ?? 0);
      } finally {
        layout.destroy();
        vi.restoreAllMocks();
      }
      expect(Math.max(...sides)).toBe(large);
    });
  });

  // Before the prep, only the slot count is known: the check there is the nested solve's (the slot atlas,
  // the CSR offsets, the slot count), not the flat layout's, whose grid pyramid the nested solve never
  // allocates. On a 60-texel device that grid estimate (64) would reject a tree every nested texture fits.
  it("checks the nested need before the prep, not the flat grid estimate: a tree that fits runs on the GPU", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limited = await deviceWithTextureLimit(60);
    try {
      const fits = tiledAndExact();
      const params = { iterations: 10, radius: 10 * Math.sqrt(fits.leafCount) };
      const g = graphOver(fits);
      const handle = startGpuNestedLayout(limited, g, fits, params, () => {}, { warnUnsupported: false });
      await handle.settled;
      expect(warn).not.toHaveBeenCalled();
      expect(handle.transport).toBe("gpu");
      expect(Array.from(g.positions)).toEqual(Array.from(direct(limited, fits, 10).positions));
    } finally {
      limited.destroy();
    }
  });

  it("an empty module tree falls back silently with warnUnsupported: false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const empty = topo(buildModuleLODTree(0, []));
    const g = buildGraph({ nodeCount: 0, source: [], target: [] });
    const handle = startGpuNestedLayout(device, g, empty, { iterations, radius }, () => {}, { warnUnsupported: false });
    await handle.settled;
    expect(handle.transport).toBe("worker");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a warm start whose GPU solve fails lands none of it: the worker lays it out, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The harvest refuses the copy, as it does when the reductions come back non-finite.
    vi.spyOn(AsyncPositionReadback.prototype, "harvest").mockReturnValue(false);
    const g = graphOver(tree);
    g.positions.set(nestedLayout(tree, { iterations, radius }).positions);
    const initial = g.positions.slice();
    const before = g.positions.slice();
    const got: { results: Float32Array[]; boundaries: BoundaryDiscs[]; transports: string[] } = { results: [], boundaries: [], transports: [] };
    const handle = startGpuNestedLayout(device, g, tree, { iterations, initial }, () => {}, {
      onTransport: (t) => got.transports.push(t),
      onResult: (positions) => got.results.push(positions),
      onBoundaries: (discs) => got.boundaries.push(discs),
    });
    await handle.settled;
    expect(got.transports).toEqual(["gpu", "worker"]);
    expect(handle.transport).toBe("worker");
    // Only the worker's result lands — the CPU warm start — never the GPU's unharvested (all-zero) arrays.
    const want = nestedLayout(tree, { iterations, initial });
    expect(got.results.length).toBe(1);
    expect(Array.from(got.results[0] ?? [])).toEqual(Array.from(want.positions));
    expect(got.boundaries.length).toBe(1);
    expect(Array.from(got.boundaries[0]?.r ?? [])).toEqual(Array.from(nestedBoundaryDiscs(tree, want).r));
    expect(Array.from(g.positions)).toEqual(Array.from(before)); // with onResult the caller lands it
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/fell back to the CPU worker: the GPU solve stopped: the layout became non-finite/);
  });

  it("a cold layout that loses its context mid-stream restarts on the worker and lands the CPU layout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (!(device instanceof WebGLDevice)) throw new Error("the test device is WebGL2");
    const canvas = device.gl.canvas;
    const g = graphOver(tree);
    const got: { frames: number; boundaries: BoundaryDiscs[]; transports: string[] } = { frames: 0, boundaries: [], transports: [] };
    const handle = startGpuNestedLayout(device, g, tree, { iterations, radius }, () => {
      // After the first streamed GPU frame: the context is lost (the event the stream listens for).
      if (++got.frames === 1) canvas.dispatchEvent(new Event("webglcontextlost"));
    }, {
      frameEvery: 10,
      onTransport: (t) => got.transports.push(t),
      onBoundaries: (discs) => got.boundaries.push(discs),
    });
    await handle.settled;
    expect(got.transports).toEqual(["gpu", "worker"]);
    const want = nestedLayout(tree, { iterations, radius });
    expect(Array.from(g.positions)).toEqual(Array.from(want.positions));
    // One set of boundary discs — the worker's — and none from the lost GPU solve.
    expect(got.boundaries.length).toBe(1);
    expect(Array.from(got.boundaries[0]?.r ?? [])).toEqual(Array.from(nestedBoundaryDiscs(tree, want).r));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/fell back to the CPU worker: the GPU solve stopped: the WebGL context was lost/);
  });

  it("stops mid-run: settles, and no frame lands after it", async () => {
    const g = graphOver(tree);
    let frames = 0;
    const handle = startGpuNestedLayout(device, g, tree, { iterations: 400, radius }, () => frames++, { frameEvery: 1 });
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();
    await handle.settled;
    const at = frames;
    await new Promise((r) => setTimeout(r, 200));
    expect(frames).toBe(at);
  });
});

describe("layout({ backend: 'gpu', nested }) through the engine (#355)", () => {
  function host(): HTMLElement {
    const el = document.createElement("div");
    el.style.width = "300px";
    el.style.height = "300px";
    document.body.appendChild(el);
    return el;
  }

  it("lays the map out on the GPU and reports the GPU transport; a warm re-layout lands in one piece", async () => {
    const records: ModuleNode[] = [];
    const n = 2000;
    for (let id = 0; id < n; id++) records.push({ id, path: [Math.floor(id / 400) + 1, Math.floor((id % 400) / 50) + 1, (id % 50) + 1] });
    const g = buildGraph({ nodeCount: n, source: Array.from({ length: n - 1 }, (_, i) => i), target: Array.from({ length: n - 1 }, (_, i) => i + 1) });
    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g, { modules: records }).layout({ backend: "gpu", nested: { iterations: 30 } });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu");
    const radius = 10 * Math.sqrt(n);
    for (let i = 0; i < 2 * n; i++) {
      expect(Number.isFinite(g.positions[i] ?? Number.NaN)).toBe(true);
      expect(Math.abs(g.positions[i] ?? 0)).toBeLessThanOrEqual(radius);
    }
    // A warm re-cluster with a transition (the Navigator's RELAYOUT): the solve reads back once, then eases.
    const tree = buildModuleLODTree(n, records, g);
    expect(tree.size).toBeGreaterThan(n);
    const cold = g.positions.slice();
    net.layout({ backend: "gpu", nested: { warm: true, iterations: 30 }, transition: 100 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu"); // the transition's handle reports the solve's transport (#297)
    let moved = 0;
    for (let i = 0; i < n; i++) moved += Math.hypot((g.positions[2 * i] ?? 0) - (cold[2 * i] ?? 0), (g.positions[2 * i + 1] ?? 0) - (cold[2 * i + 1] ?? 0));
    expect(moved / n).toBeLessThan(0.1 * radius); // a refinement of the map, placed where it was
    net.destroy();
  });
});
