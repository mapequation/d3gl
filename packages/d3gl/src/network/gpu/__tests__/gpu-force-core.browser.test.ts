import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { buildGraph } from "../../graph.js";

describe("GpuForceLayout integrate", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("attraction pulls two connected nodes together", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([0, 0, 100, 0]);
    const layout = new GpuForceLayout(device, g, {
      repulsion: 0,
      attraction: 0.1,
      centering: 0,
      alpha: 0.5,
      theta: 0.9,
    });
    layout.runFrame(30);
    const out = new Float32Array(4);
    layout.readPositions(out);
    // Overall distance decreased.
    expect(Math.hypot(out[2]! - out[0]!, out[3]! - out[1]!)).toBeLessThan(100);
    // Symmetric spring: node 0 moved in +x direction, node 1 moved in −x direction.
    expect(out[0]!).toBeGreaterThan(0);   // node 0 pulled toward node 1
    expect(out[2]!).toBeLessThan(100);    // node 1 pulled toward node 0
  });

  it("with zero forces, positions are unchanged after a tick", () => {
    const g = buildGraph({ nodeCount: 3, source: [], target: [] });
    g.positions.set([0, 0, 10, 0, 0, 10]);
    const layout = new GpuForceLayout(device, g, {
      repulsion: 0,
      attraction: 0,
      centering: 0,
      alpha: 0.2,
      theta: 0.9,
    });
    layout.runFrame(1);
    const out = new Float32Array(6);
    layout.readPositions(out);
    expect(Array.from(out)).toEqual([0, 0, 10, 0, 0, 10]);
  });

  it("ticking creates no framebuffers (all MRT targets pre-created in the constructor)", () => {
    const g = buildGraph({ nodeCount: 3, source: [], target: [] });
    g.positions.set([0, 0, 10, 0, 0, 10]);
    const layout = new GpuForceLayout(device, g, {
      repulsion: 0,
      attraction: 0,
      centering: 0,
      alpha: 0.2,
      theta: 0.9,
    });

    // Spy only around ticking — the constructor legitimately pre-creates the two
    // MRT framebuffers; readPositions legitimately creates a readback FBO. The hot
    // path (runFrame → _tick) must reuse the pre-created FBOs and allocate none.
    const spy = vi.spyOn(device, "createFramebuffer");
    layout.runFrame(10);
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore();
  });
});
