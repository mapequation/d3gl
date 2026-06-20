import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { InstancedCircles } from "../instanced.js";
import { clipFromView } from "../index.js";
import { WebGLBackend } from "../webgl-backend.js";

const W = 64;
const H = 64;

async function setup() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const device = await luma.createDevice({
    adapters: [webgl2Adapter],
    type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false },
  });
  const framebuffer = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"] });
  return { device, framebuffer };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function px(device: any, framebuffer: any, x: number, y: number): Uint8Array {
  return device.readPixelsToArrayWebGL(framebuffer, { sourceX: x, sourceY: y, sourceWidth: 1, sourceHeight: 1 });
}

describe("InstancedCircles", () => {
  it("draws a circle at its world centre in its colour, transparent outside the disc", async () => {
    const { device, framebuffer } = await setup();
    const circles = new InstancedCircles(
      device,
      { centers: new Float32Array([32, 32]), radii: new Float32Array([12]), colors: new Uint8Array([255, 0, 0, 255]), count: 1 },
      W,
      H,
    );
    circles.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    circles.render(pass);
    pass.end();
    device.submit();

    const centre = px(device, framebuffer, 32, 32);
    const outside = px(device, framebuffer, 2, 2);
    expect(centre[0]).toBeGreaterThan(200); // red present at the centre
    expect(centre[3]!).toBeGreaterThan(200); // opaque
    expect(outside[3]).toBe(0); // transparent outside the disc

    circles.destroy();
    device.destroy();
  });

  it("draws multiple instances at distinct centres/colours", async () => {
    const { device, framebuffer } = await setup();
    // two circles on the same row (y=32, the framebuffer centre row → no y-flip ambiguity)
    const circles = new InstancedCircles(
      device,
      {
        centers: new Float32Array([16, 32, 48, 32]),
        radii: new Float32Array([8, 8]),
        colors: new Uint8Array([0, 255, 0, 255, 0, 0, 255, 255]),
        count: 2,
      },
      W,
      H,
    );
    circles.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    circles.render(pass);
    pass.end();
    device.submit();

    const green = px(device, framebuffer, 16, 32);
    const blue = px(device, framebuffer, 48, 32);
    expect(green[1]).toBeGreaterThan(200);
    expect(blue[2]).toBeGreaterThan(200);

    circles.destroy();
    device.destroy();
  });
});

describe("WebGLBackend instanced layer", () => {
  it("renders an instanced circles layer through the backend (readPixel)", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: W, height: H });

    backend.setInstancedLayer({
      name: "nodes",
      primitive: "circles",
      circles: { centers: new Float32Array([32, 32]), radii: new Float32Array([12]), colors: new Uint8Array([0, 200, 0, 255]), count: 1 },
      sizeMode: "world",
    });
    backend.setTransform({ k: 1, x: 0, y: 0 });

    const centre = backend.readPixel(32, 32);
    const outside = backend.readPixel(2, 2);
    expect(centre[1]).toBeGreaterThan(150); // green node present at the centre
    expect(outside[3]).toBe(0); // transparent elsewhere

    backend.removeInstancedLayer("nodes");
    expect(backend.readPixel(32, 32)[3]).toBe(0); // gone after removal

    backend.destroy();
  });
});
