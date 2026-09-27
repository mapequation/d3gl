/**
 * The GPU nested layout's handle (#355): streaming, one-frame warm starts, boundary discs, the worker
 * fallback, and `layout({ backend: "gpu", nested })` through the engine.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { startGpuNestedLayout } from "../gpu-nested-transport.js";
import { GpuNestedLayout } from "../gpu-nested-layout.js";
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

/** The direct solver's composed result on `device` — the reference the handle's output must equal bitwise. */
function direct(device: Device, tree: NestedLayoutTopology, iterations: number, initial?: Float32Array): ReturnType<typeof nestedSolverResult> {
  const solver = nestedSolverTopology(tree, { iterations, radius: initial ? undefined : 10 * Math.sqrt(tree.leafCount), initial });
  const layout = new GpuNestedLayout(device, solver);
  try {
    for (let t = 0; t < solver.iterations; t++) {
      layout.beginTick();
      layout.forceBand(0, 1);
      layout.integrate();
    }
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
    let boundaries: BoundaryDiscs | null = null;
    const handle = startGpuNestedLayout(device, g, tree, { iterations, radius }, () => frames++, {
      frameEvery: 10,
      onBoundaries: (discs) => {
        boundaries = discs;
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
    expect(boundaries).not.toBeNull();
    const got = boundaries as BoundaryDiscs | null;
    expect(Array.from(got?.r ?? [])).toEqual(Array.from(wantDiscs.r));
    expect(Array.from(got?.dx ?? [])).toEqual(Array.from(wantDiscs.dx));
  });

  it("reads a warm start back in one frame, placed over the current map, without touching the graph first", async () => {
    const g = graphOver(tree);
    const cold = nestedLayout(tree, { iterations, radius });
    g.positions.set(cold.positions);
    const initial = g.positions.slice();
    const before = g.positions.slice();
    let frames = 0;
    let result: Float32Array | null = null;
    const handle = startGpuNestedLayout(device, g, tree, { iterations, initial }, () => frames++, {
      onResult: (positions) => {
        result = positions;
        // Still the old map when the result arrives: a transition eases from it.
        expect(Array.from(g.positions)).toEqual(Array.from(before));
      },
    });
    await handle.settled;
    expect(frames).toBe(0); // with onResult the caller lands it
    const want = direct(device, tree, iterations, initial);
    expect(result).not.toBeNull();
    expect(Array.from(result ?? [])).toEqual(Array.from(want.positions));
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
    net.data(g, { modules: records }).layout({ backend: "gpu", nested: true, iterations: 30 });
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
    net.layout({ backend: "gpu", nested: { warm: true }, transition: 100, iterations: 30 });
    await net.whenSettled();
    let moved = 0;
    for (let i = 0; i < n; i++) moved += Math.hypot((g.positions[2 * i] ?? 0) - (cold[2 * i] ?? 0), (g.positions[2 * i + 1] ?? 0) - (cold[2 * i + 1] ?? 0));
    expect(moved / n).toBeLessThan(0.1 * radius); // a refinement of the map, placed where it was
    net.destroy();
  });
});
