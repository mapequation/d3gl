import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import type { Device } from "@luma.gl/core";
import {
  overlappingBorderedShapes,
  strokeJoinShapes,
  renderWebGL,
  renderCanvas,
  diffPixels,
} from "./__tests__/backend-equivalence-harness.js";

const W = 200;
const H = 200;

async function makeDevice(): Promise<Device> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  return luma.createDevice({
    adapters: [webgl2Adapter],
    type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false },
  });
}

describe("backend equivalence: overlapping bordered shapes (#41)", () => {
  it("WebGL composites overlapping fills/strokes identically to Canvas", async () => {
    const device = await makeDevice();
    const scene = overlappingBorderedShapes(W, H);

    const gl = renderWebGL(device, scene, "shapes", W, H);
    const cv = renderCanvas(scene, "shapes", W, H);

    const diff = diffPixels(gl, cv);
    // Sanity: the scene must actually have rendered content in both backends.
    expect(diff.considered).toBeGreaterThan(W * H * 0.2);
    // Equivalence (position-tolerant, so ~1px stroke-rasterizer differences don't count):
    // the draw-order bug leaves several-px-wide white border bands on WebGL that Canvas
    // occludes — far wider than the 1px tolerance, so it scores many percent and fails.
    // Once WebGL composites in painter's order, only a handful of pixels differ (<0.5%).
    expect(diff.fraction).toBeLessThan(0.01);
  });

  it("WebGL strokes joins/caps identically to Canvas (miter + limit)", async () => {
    const device = await makeDevice();
    const scene = strokeJoinShapes(W, H);

    const gl = renderWebGL(device, scene, "lines", W, H);
    const cv = renderCanvas(scene, "lines", W, H);

    const diff = diffPixels(gl, cv);
    expect(diff.considered).toBeGreaterThan(W * H * 0.05);
    // WebGL beveled every corner while Canvas miters them — sharp corners add several-px
    // pointed regions far wider than the 1px tolerance. Passes once WebGL miters with the
    // same limit and Canvas is pinned to that limit + miter join + butt caps.
    expect(diff.fraction).toBeLessThan(0.01);
  });
});
