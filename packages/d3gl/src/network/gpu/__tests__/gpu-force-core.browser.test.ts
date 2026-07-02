import { describe, it, expect, beforeAll } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { buildGraph } from "../../graph.js";

describe("GpuForceLayout integrate", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

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
});
