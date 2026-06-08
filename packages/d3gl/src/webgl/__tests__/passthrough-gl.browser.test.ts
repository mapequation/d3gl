import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import type { DrawBatch, ProjectedPath } from "../../core/index.js";
import { PassThroughGL } from "../passthrough-gl.js";

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
  const target = device.createFramebuffer({
    width: W,
    height: H,
    colorAttachments: ["rgba8unorm"],
  });
  return { device, target };
}

/**
 * Read the RGBA byte tuple at a target pixel addressed in *reference* coords (origin
 * top-left, y down — the space positions/radii live in). readPixels' origin is
 * bottom-left, so y is flipped, mirroring the renderer's own browser tests.
 */
function pixel(device: any, framebuffer: any, x: number, y: number): number[] {
  const p = device.readPixelsToArrayWebGL(framebuffer, { sourceX: x, sourceY: H - 1 - y });
  return [p[0], p[1], p[2], p[3]];
}

function batch(
  positions: number[],
  radii: number[],
  colors: number[],
): DrawBatch {
  return {
    points: {
      positions: new Float32Array(positions),
      radii: new Float32Array(radii),
      colors: new Uint8Array(colors),
      count: radii.length,
    },
    paths: null,
  };
}

/** A DrawBatch carrying only paths (no points). */
function pathBatch(paths: ProjectedPath[]): DrawBatch {
  return { points: null, paths };
}

/** A closed square subpath (CCW in screen coords) spanning [x0,x1]×[y0,y1]. */
function square(x0: number, y0: number, x1: number, y1: number): ProjectedPath["subpaths"][number] {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true };
}

/** Composite the pass-through layer onto a fresh (transparent) target. */
function composite(
  device: any,
  target: any,
  pt: PassThroughGL,
  from: { k: number; x: number; y: number },
  to: { k: number; x: number; y: number },
) {
  const pass = device.beginRenderPass({ framebuffer: target, clearColor: [0, 0, 0, 0] });
  pt.composite(pass, from, to);
  pass.end();
  device.submit();
}

describe("PassThroughGL", () => {
  it("renders a colored point and composites it 1:1", async () => {
    const { device, target } = await setup();
    const pt = new PassThroughGL(device, W, H);

    pt.draw(batch([32, 32], [8], [255, 0, 0, 255]), { k: 1, x: 0, y: 0 }, true);
    composite(device, target, pt, { k: 1, x: 0, y: 0 }, { k: 1, x: 0, y: 0 });

    const center = pixel(device, target, 32, 32);
    expect(center[0]).toBeGreaterThan(200); // red
    expect(center[1]).toBeLessThan(40);
    expect(center[2]).toBeLessThan(40);

    const corner = pixel(device, target, 2, 2);
    expect(corner[3]).toBeLessThan(40); // transparent / empty

    pt.destroy();
    target.destroy();
    device.destroy();
  });

  it("accumulates appended batches without clearing (preserve)", async () => {
    const { device, target } = await setup();
    const pt = new PassThroughGL(device, W, H);

    // A: clear:true at (16,16). B: clear:false (append) at (48,48).
    pt.draw(batch([16, 16], [6], [255, 0, 0, 255]), { k: 1, x: 0, y: 0 }, true);
    pt.draw(batch([48, 48], [6], [0, 255, 0, 255]), { k: 1, x: 0, y: 0 }, false);
    composite(device, target, pt, { k: 1, x: 0, y: 0 }, { k: 1, x: 0, y: 0 });

    const a = pixel(device, target, 16, 16);
    const b = pixel(device, target, 48, 48);
    expect(a[0]).toBeGreaterThan(200); // A (red) survived the append
    expect(b[1]).toBeGreaterThan(200); // B (green) present

    pt.destroy();
    target.destroy();
    device.destroy();
  });

  it("carries per-point color as a vertex attribute (no shared table)", async () => {
    const { device, target } = await setup();
    const pt = new PassThroughGL(device, W, H);

    // Two points in one batch, different colors.
    pt.draw(
      batch([16, 32, 48, 32], [6, 6], [255, 0, 0, 255, 0, 0, 255, 255]),
      { k: 1, x: 0, y: 0 },
      true,
    );
    composite(device, target, pt, { k: 1, x: 0, y: 0 }, { k: 1, x: 0, y: 0 });

    const left = pixel(device, target, 16, 32);
    const right = pixel(device, target, 48, 32);
    expect(left[0]).toBeGreaterThan(200); // red point
    expect(left[2]).toBeLessThan(40);
    expect(right[2]).toBeGreaterThan(200); // blue point
    expect(right[0]).toBeLessThan(40);

    pt.destroy();
    target.destroy();
    device.destroy();
  });

  it("screen mode keeps a constant pixel radius (no zoom scaling); world mode scales", async () => {
    const { device, target } = await setup();
    // World mode (default) at 2x zoom: a radius-4 point at (8,8) maps to screen (16,16)
    // and grows to ~8px, so a pixel ~6px out from the centre is still inside.
    const world = new PassThroughGL(device, W, H);
    world.draw(batch([8, 8], [4], [255, 0, 0, 255]), { k: 2, x: 0, y: 0 }, true);
    composite(device, target, world, { k: 2, x: 0, y: 0 }, { k: 2, x: 0, y: 0 });
    const worldEdge = pixel(device, target, 16 + 6, 16);
    expect(worldEdge[0]).toBeGreaterThan(150); // world radius scaled up → still painted
    world.destroy();

    // Screen mode: same point, same zoom — radius stays 4px, so 6px out is OUTSIDE.
    const t2 = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"] });
    const screen = new PassThroughGL(device, W, H);
    screen.setScreenMode(true);
    screen.draw(batch([8, 8], [4], [255, 0, 0, 255]), { k: 2, x: 0, y: 0 }, true);
    composite(device, t2, screen, { k: 2, x: 0, y: 0 }, { k: 2, x: 0, y: 0 });
    const screenCenter = pixel(device, t2, 16, 16);
    expect(screenCenter[0]).toBeGreaterThan(200); // centre still painted (constant radius)
    const screenEdge = pixel(device, t2, 16 + 6, 16);
    expect(screenEdge[3]).toBeLessThan(60);        // 6px out is outside the 4px radius
    screen.destroy();
    t2.destroy();
    target.destroy();
    device.destroy();
  });

  it("offsets the accumulated layer via the blit delta (snapshot-pan)", async () => {
    const { device, target } = await setup();
    const pt = new PassThroughGL(device, W, H);

    // Rasterize at s={k:1}: a point at world (16,16) → fbo pixel (16,16).
    const s = { k: 1, x: 0, y: 0 };
    pt.draw(batch([16, 16], [4], [255, 0, 0, 255]), s, true);

    // Composite from=s to={k:2}: the 2x zoom maps world (16,16) → screen pixel (32,32).
    composite(device, target, pt, s, { k: 2, x: 0, y: 0 });

    const moved = pixel(device, target, 32, 32);
    expect(moved[0]).toBeGreaterThan(200); // appears at the 2x-zoomed location
    const original = pixel(device, target, 16, 16);
    expect(original[3]).toBeLessThan(40); // no longer at the un-zoomed location

    pt.destroy();
    target.destroy();
    device.destroy();
  });

  it("rasterizes a filled polygon into the FBO (inside pixel reads the fill)", async () => {
    const { device, target } = await setup();
    const pt = new PassThroughGL(device, W, H);

    pt.draw(
      pathBatch([{ subpaths: [square(16, 16, 48, 48)], fill: [255, 0, 0, 255], stroke: null, lineWidth: 0 }]),
      { k: 1, x: 0, y: 0 },
      true,
    );
    composite(device, target, pt, { k: 1, x: 0, y: 0 }, { k: 1, x: 0, y: 0 });

    const inside = pixel(device, target, 32, 32);
    expect(inside[0]).toBeGreaterThan(200); // red fill
    expect(inside[1]).toBeLessThan(40);
    expect(inside[3]).toBeGreaterThan(200);
    const outside = pixel(device, target, 4, 4);
    expect(outside[3]).toBeLessThan(40); // empty outside the polygon

    pt.destroy();
    target.destroy();
    device.destroy();
  });

  it("rasterizes a stroked open line into the FBO (a pixel on the line reads the stroke)", async () => {
    const { device, target } = await setup();
    const pt = new PassThroughGL(device, W, H);

    // Horizontal line across the middle, thick enough to cover the sampled pixel.
    pt.draw(
      pathBatch([
        {
          subpaths: [{ points: [8, 32, 56, 32], closed: false }],
          fill: null,
          stroke: [0, 0, 255, 255],
          lineWidth: 8,
        },
      ]),
      { k: 1, x: 0, y: 0 },
      true,
    );
    composite(device, target, pt, { k: 1, x: 0, y: 0 }, { k: 1, x: 0, y: 0 });

    const onLine = pixel(device, target, 32, 32);
    expect(onLine[2]).toBeGreaterThan(200); // blue stroke
    expect(onLine[0]).toBeLessThan(40);
    const offLine = pixel(device, target, 32, 8);
    expect(offLine[3]).toBeLessThan(40); // empty above the line

    pt.destroy();
    target.destroy();
    device.destroy();
  });

  it("carries per-path fill color (two polygons, two colors)", async () => {
    const { device, target } = await setup();
    const pt = new PassThroughGL(device, W, H);

    pt.draw(
      pathBatch([
        { subpaths: [square(4, 4, 28, 28)], fill: [255, 0, 0, 255], stroke: null, lineWidth: 0 },
        { subpaths: [square(36, 36, 60, 60)], fill: [0, 0, 255, 255], stroke: null, lineWidth: 0 },
      ]),
      { k: 1, x: 0, y: 0 },
      true,
    );
    composite(device, target, pt, { k: 1, x: 0, y: 0 }, { k: 1, x: 0, y: 0 });

    const red = pixel(device, target, 16, 16);
    const blue = pixel(device, target, 48, 48);
    expect(red[0]).toBeGreaterThan(200); // first polygon is red
    expect(red[2]).toBeLessThan(40);
    expect(blue[2]).toBeGreaterThan(200); // second polygon is blue (correct index rebasing)
    expect(blue[0]).toBeLessThan(40);

    pt.destroy();
    target.destroy();
    device.destroy();
  });

  it("renders points and a polygon in the same batch", async () => {
    const { device, target } = await setup();
    const pt = new PassThroughGL(device, W, H);

    const mixed: DrawBatch = {
      points: {
        positions: new Float32Array([48, 16]),
        radii: new Float32Array([6]),
        colors: new Uint8Array([0, 255, 0, 255]),
        count: 1,
      },
      paths: [{ subpaths: [square(8, 36, 32, 60)], fill: [255, 0, 0, 255], stroke: null, lineWidth: 0 }],
    };
    pt.draw(mixed, { k: 1, x: 0, y: 0 }, true);
    composite(device, target, pt, { k: 1, x: 0, y: 0 }, { k: 1, x: 0, y: 0 });

    const point = pixel(device, target, 48, 16);
    const poly = pixel(device, target, 20, 48);
    expect(point[1]).toBeGreaterThan(200); // green point
    expect(poly[0]).toBeGreaterThan(200); // red polygon fill

    pt.destroy();
    target.destroy();
    device.destroy();
  });

  it("accumulates a polygon (clear:true) then another (clear:false) — both present", async () => {
    const { device, target } = await setup();
    const pt = new PassThroughGL(device, W, H);

    pt.draw(
      pathBatch([{ subpaths: [square(4, 4, 28, 28)], fill: [255, 0, 0, 255], stroke: null, lineWidth: 0 }]),
      { k: 1, x: 0, y: 0 },
      true,
    );
    pt.draw(
      pathBatch([{ subpaths: [square(36, 36, 60, 60)], fill: [0, 0, 255, 255], stroke: null, lineWidth: 0 }]),
      { k: 1, x: 0, y: 0 },
      false,
    );
    composite(device, target, pt, { k: 1, x: 0, y: 0 }, { k: 1, x: 0, y: 0 });

    const first = pixel(device, target, 16, 16);
    const second = pixel(device, target, 48, 48);
    expect(first[0]).toBeGreaterThan(200); // first polygon survived the append
    expect(second[2]).toBeGreaterThan(200); // appended polygon present

    pt.destroy();
    target.destroy();
    device.destroy();
  });
});
