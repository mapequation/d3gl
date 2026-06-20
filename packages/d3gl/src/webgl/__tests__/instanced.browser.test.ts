import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import type { Device, Framebuffer } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { InstancedCircles, InstancedLines, InstancedArrows } from "../instanced.js";
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

function px(device: Device, framebuffer: Framebuffer, x: number, y: number) {
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

describe("InstancedLines", () => {
  it("draws an instanced straight line at its world endpoints in its colour", async () => {
    const { device, framebuffer } = await setup();
    const lines = new InstancedLines(
      device,
      {
        sources: new Float32Array([10, 32]),
        targets: new Float32Array([54, 32]),
        widths: new Float32Array([6]),
        colors: new Uint8Array([0, 0, 255, 255]),
        count: 1,
      },
      W,
      H,
    );
    lines.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    lines.render(pass);
    pass.end();
    device.submit();

    const onLine = px(device, framebuffer, 32, 32); // midpoint, on the segment
    const offLine = px(device, framebuffer, 32, 10); // away from the segment
    expect(onLine[2]).toBeGreaterThan(200); // blue along the line
    expect(offLine[3]).toBe(0); // transparent away from it

    lines.destroy();
    device.destroy();
  });
});

describe("InstancedArrows", () => {
  it("draws a triangle arrowhead at the tip, oriented from source to target", async () => {
    const { device, framebuffer } = await setup();
    const arrows = new InstancedArrows(
      device,
      {
        sources: new Float32Array([0, 32]),
        targets: new Float32Array([54, 32]), // tip at x=54, pointing +x
        sizes: new Float32Array([10]),
        colors: new Uint8Array([255, 0, 0, 255]),
        count: 1,
      },
      W,
      H,
    );
    arrows.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    arrows.render(pass);
    pass.end();
    device.submit();

    const inside = px(device, framebuffer, 48, 32); // on axis, between tip (54) and base (34)
    const before = px(device, framebuffer, 20, 32); // before the base — outside the triangle
    expect(inside[0]).toBeGreaterThan(200); // red arrowhead
    expect(before[3]).toBe(0); // transparent before the base

    arrows.destroy();
    device.destroy();
  });
});
