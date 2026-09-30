/**
 * Module links as springs on the GPU flat solver (#455).
 *
 *   1. Parity: from identical positions, the force the module springs add on the GPU (the force texture with
 *      them minus the one without) is the CPU `ModuleSpringForce`'s — on the `.ftree`-shaped fixture, and on a
 *      star of module links whose centre has more springs than one row gathers (the #350 hub chunks).
 *   2. Behaviour: a GPU drag of module 1 (pinned, held positions moved every frame) pulls module 2, linked to
 *      it, and not the unlinked modules — as the CPU drag does.
 *   3. Without module springs the solver compiles and runs none of their passes.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { moduleSpringPrograms } from "../module-springs.js";
import { SPRING_CHUNK } from "../hub-chunks.js";
import { DEFAULT_FORCE, DRAG_HEAT } from "../../force.js";
import { multilevelLayout } from "../../coarsen.js";
import { buildGraph } from "../../graph.js";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../../modules.js";
import { ModuleSpringForce, moduleSpringsOf, type ModuleSprings } from "../../module-springs.js";
import { withModuleSprings } from "../../worker-transport.js";
import { LINKS, TOPS, centroid, fixture, springsOf } from "../../__tests__/module-springs-fixture.js";

const PARAMS = { ...DEFAULT_FORCE };

/** The GPU force of one tick from the graph's current positions. */
function gpuForces(device: Device, graph: Parameters<typeof withModuleSprings>[0], springs: ModuleSprings | undefined): Float32Array {
  const layout = new GpuForceLayout(device, withModuleSprings(graph, springs), PARAMS);
  layout.beginTick();
  layout.forceBand(0, 1);
  const out = new Float32Array(graph.nodeCount * 2);
  layout.readForces(out);
  layout.destroy();
  return out;
}

/** Expect the GPU's module-spring force (with − without) to be the CPU's, within float32 rounding of the scale. */
function expectParity(device: Device, graph: Parameters<typeof withModuleSprings>[0], springs: ModuleSprings): void {
  const n = graph.nodeCount;
  const withSprings = gpuForces(device, graph, springs);
  const without = gpuForces(device, graph, undefined);
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  new ModuleSpringForce(springs).apply(graph.positions, PARAMS.attraction, fx, fy);
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(fx[i]!), Math.abs(fy[i]!), Math.abs(without[i * 2]!), Math.abs(without[i * 2 + 1]!));
  expect(scale).toBeGreaterThan(0);
  const tolerance = 1e-4 * scale;
  let nonzero = 0;
  for (let i = 0; i < n; i++) {
    expect(Math.abs(withSprings[i * 2]! - without[i * 2]! - fx[i]!)).toBeLessThan(tolerance);
    expect(Math.abs(withSprings[i * 2 + 1]! - without[i * 2 + 1]! - fy[i]!)).toBeLessThan(tolerance);
    if (Math.abs(fx[i]!) + Math.abs(fy[i]!) > tolerance) nonzero++;
  }
  expect(nonzero).toBeGreaterThan(0);
}

describe("GPU module springs (#455)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("adds the CPU's module-spring force, from the same positions", () => {
    const f = fixture();
    const springs = springsOf(f, [...LINKS, { source: [3, 1, 2], target: [1, 2], flow: 0.02 }]);
    multilevelLayout(withModuleSprings(f.graph, springs), { width: 800, height: 600, iterations: 60 });
    expectParity(device, f.graph, springs);
  });

  it(`matches it on a hub endpoint (more than ${SPRING_CHUNK} springs: the chunked row gather)`, () => {
    // One centre module [1] and SPOKES leaf modules [s + 2], each linked to the centre both ways.
    const spokes = SPRING_CHUNK + 40;
    const records: ModuleNode[] = [];
    let id = 0;
    for (let r = 1; r <= 4; r++) records.push({ id: id++, path: [1, r] });
    for (let s = 0; s < spokes; s++) for (let r = 1; r <= 2; r++) records.push({ id: id++, path: [s + 2, r] });
    const links: ModuleLink[] = [];
    for (let s = 0; s < spokes; s++) {
      links.push({ source: [1], target: [s + 2], flow: 0.001 * (1 + (s % 7)) });
      links.push({ source: [s + 2], target: [1], flow: 0.002 });
    }
    const source = Array.from({ length: id / 2 }, (_, k) => 2 * k);
    const graph = buildGraph({ nodeCount: id, source, target: source.map((s) => s + 1), weight: source.map(() => 0.01) });
    const springs = moduleSpringsOf(buildModuleLODTree(id, records, graph, links), graph);
    if (!springs) throw new Error("expected module springs");
    let seed = 5;
    const rng = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < id * 2; i++) graph.positions[i] = rng() * 2000 - 1000;
    expectParity(device, graph, springs);
  });

  it("a GPU drag of a module pulls the module linked to it, not the unlinked ones", () => {
    /** Module 2's and the other modules' mean follow, in spacings, of a 12-spacing drag of module 1 over 30 frames. */
    const drag = (links: ModuleLink[] | null): { followed2: number; others: number } => {
      const f = fixture();
      const springs = links ? springsOf(f, links) : undefined;
      const graph = withModuleSprings(f.graph, springs);
      multilevelLayout(graph, { width: 800, height: 600, iterations: 300 });
      const p = graph.positions;
      const m1 = f.top(1);
      const [x1, y1] = centroid(p, m1);
      const [x0, y0] = centroid(p, Array.from({ length: f.graph.nodeCount }, (_, i) => i));
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const ux = (x1 - x0) / len;
      const uy = (y1 - y0) / len;
      const spacing = Math.sqrt((Math.PI * PARAMS.repulsion) / PARAMS.centering);
      const before = Array.from({ length: TOPS }, (_, t) => centroid(p, f.top(t + 1)));
      const layout = new GpuForceLayout(device, graph, PARAMS);
      const ids = Uint32Array.from(m1);
      const held = new Float32Array(ids.length * 2);
      layout.setPinned(ids);
      layout.hold(DRAG_HEAT);
      const frames = 30;
      for (let frame = 1; frame <= frames; frame++) {
        const t = (frame / frames) * 12 * spacing;
        m1.forEach((i, k) => {
          held[k * 2] = p[i * 2]! + t * ux;
          held[k * 2 + 1] = p[i * 2 + 1]! + t * uy;
        });
        layout.setHeldPositions(ids, held);
        layout.runFrame(1);
      }
      const out = new Float32Array(f.graph.nodeCount * 2);
      layout.readPositions(out);
      layout.destroy();
      const along = (t: number): number => {
        const [x, y] = centroid(out, f.top(t));
        const [bx, by] = before[t - 1]!;
        return ((x - bx) * ux + (y - by) * uy) / spacing;
      };
      let others = 0;
      for (let t = 3; t <= TOPS; t++) others += along(t) / (TOPS - 2);
      return { followed2: along(2), others };
    };
    const linked = drag(LINKS);
    const plain = drag(null);
    expect(linked.followed2 - linked.others).toBeGreaterThan(4);
    expect(Math.abs(plain.followed2 - plain.others)).toBeLessThan(1);
  });

  it("lists the module springs' programs for the warm-up (#385) only for a graph with module springs", () => {
    const f = fixture();
    const springs = springsOf(f, LINKS);
    const plain = new Set(GpuForceLayout.programs(f.graph).map((p) => p.fs));
    const own = moduleSpringPrograms(springs).filter((p) => !plain.has(p.fs));
    expect(own.length).toBeGreaterThanOrEqual(4); // the centroid map's gather + query, the centroids, the endpoint springs, the hand-down
    const withSprings = new Set(GpuForceLayout.programs(withModuleSprings(f.graph, springs)).map((p) => p.fs));
    for (const p of own) expect(withSprings.has(p.fs)).toBe(true);
  });
});
