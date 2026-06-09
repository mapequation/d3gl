import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import type { Device } from "@luma.gl/core";
import {
  overlappingBorderedShapes,
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
    // Equivalence: at most a sliver of edge-antialiasing pixels may differ. The
    // draw-order bug makes WebGL keep every white border on top while Canvas
    // occludes them — that's a large mismatch (many percent), so this fails until
    // WebGL composites in painter's order.
    expect(diff.fraction).toBeLessThan(0.02);
  });
});
