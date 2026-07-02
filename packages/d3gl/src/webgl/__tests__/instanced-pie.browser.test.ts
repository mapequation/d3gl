import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import type { Device, Framebuffer } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { InstancedPie } from "../instanced.js";
import { clipFromView } from "../index.js";
import { WebGLBackend } from "../webgl-backend.js";
import { Scene } from "../../core/index.js";
import { physicalPieInstances, tracePieWedges } from "../../network/glyphs.js";
import type { PhysicalPieWedges } from "../../network/pie.js";
import { renderCanvas, diffPixels, type PixelBuffer } from "../../map/__tests__/backend-equivalence-harness.js";

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

const isRed = (p: Uint8Array | Uint8ClampedArray) => p[0]! > 180 && p[2]! < 90;
const isBlue = (p: Uint8Array | Uint8ClampedArray) => p[2]! > 180 && p[0]! < 90;

describe("InstancedPie", () => {
  it("splits a disc into two angular wedges of the given colours, transparent outside", async () => {
    const { device, framebuffer } = await setup();
    // A pie at (32,32) r=16 split at the x-axis: wedge [0,0.5] red (angles 0..π), [0.5,1] blue (π..2π).
    // The two wedges share a centre/radius (one pie, two instances).
    const pie = new InstancedPie(
      device,
      {
        centers: new Float32Array([32, 32, 32, 32]),
        radii: new Float32Array([16, 16]),
        angles: new Float32Array([0, 0.5, 0.5, 1]),
        colors: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
        count: 2,
      },
      W,
      H,
    );
    pie.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    pie.render(pass);
    pass.end();
    device.submit();

    // Above and below the centre lie in opposite half-wedges (split is on the x-axis). One is red, the
    // other blue — assert they differ and cover both colours (y-flip-agnostic).
    const above = px(device, framebuffer, 32, 44);
    const below = px(device, framebuffer, 32, 20);
    expect(above[3]!).toBeGreaterThan(200); // opaque inside the disc
    expect(below[3]!).toBeGreaterThan(200);
    expect((isRed(above) && isBlue(below)) || (isBlue(above) && isRed(below))).toBe(true);

    const outside = px(device, framebuffer, 32, 60); // 28px from centre > r=16
    expect(outside[3]).toBe(0); // transparent outside the disc

    pie.destroy();
    device.destroy();
  });

  it("updates instances in place (sub-upload within capacity, no object recreation)", async () => {
    const { device, framebuffer } = await setup();
    const pie = new InstancedPie(
      device,
      { centers: new Float32Array([32, 32, 32, 32]), radii: new Float32Array([16, 16]), angles: new Float32Array([0, 0.5, 0.5, 1]), colors: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), count: 2 },
      W,
      H,
    );
    pie.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    // Recolour both wedges green via an in-place update (same count → sub-upload path).
    pie.update(device, {
      centers: new Float32Array([32, 32, 32, 32]),
      radii: new Float32Array([16, 16]),
      angles: new Float32Array([0, 0.5, 0.5, 1]),
      colors: new Uint8Array([0, 200, 0, 255, 0, 200, 0, 255]),
      count: 2,
    });

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    pie.render(pass);
    pass.end();
    device.submit();

    const above = px(device, framebuffer, 32, 44);
    const below = px(device, framebuffer, 32, 20);
    expect(above[1]!).toBeGreaterThan(150); // both wedges now green
    expect(below[1]!).toBeGreaterThan(150);

    pie.destroy();
    device.destroy();
  });
});

/** Render an InstancedPie into an offscreen FBO and read back as a TOP-left RGBA buffer (rows flipped
 *  from GL's bottom-left origin to match Canvas), mirroring the harness's renderWebGL. */
function renderInstancedPie(device: Device, framebuffer: Framebuffer, data: Parameters<typeof InstancedPie.prototype.update>[1], size: number): PixelBuffer {
  const pie = new InstancedPie(device, data, size, size);
  pie.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, size, size));
  const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
  pie.render(pass);
  pass.end();
  device.submit();
  const raw = device.readPixelsToArrayWebGL(framebuffer, { sourceX: 0, sourceY: 0, sourceWidth: size, sourceHeight: size }) as Uint8Array;
  const out = new Uint8Array(size * size * 4);
  const rowBytes = size * 4;
  for (let y = 0; y < size; y++) out.set(raw.subarray((size - 1 - y) * rowBytes, (size - y) * rowBytes), y * rowBytes);
  pie.destroy();
  return { width: size, height: size, data: out };
}

describe("pie backend equivalence (#171)", () => {
  it("renders the WebGL instanced pie ≈ the Canvas/SVG traced wedges (same partition)", async () => {
    const S = 96;
    // One overlapping physical node at (48,48) with three unequal wedges (r=28, world units).
    const wedges: PhysicalPieWedges = {
      offset: new Uint32Array([0, 3]),
      end: new Float32Array([0.3, 0.65, 1]),
      color: ["#e41a1c", "#377eb8", "#4daf4a"],
      moduleKey: ["1", "2", "3"],
      wedgeCount: new Uint32Array([3]),
    };
    const positions = new Float32Array([48, 48]);
    const R = 28;

    // WebGL: the instanced primitive.
    const canvasGL = document.createElement("canvas");
    canvasGL.width = S;
    canvasGL.height = S;
    document.body.appendChild(canvasGL);
    const device = await luma.createDevice({ adapters: [webgl2Adapter], type: "webgl", createCanvasContext: { canvas: canvasGL, useDevicePixels: false } });
    const fbo = device.createFramebuffer({ width: S, height: S, colorAttachments: ["rgba8unorm"] });
    const webgl = renderInstancedPie(device, fbo, physicalPieInstances(wedges, positions, R), S);

    // Canvas: the traced-wedge Scene twin (the SVG backend consumes the SAME Scene, so it matches too).
    const scene = new Scene();
    scene.group("pie", (g) => tracePieWedges(g, wedges, positions, R, false));
    for (let k = 0; k < wedges.color.length; k++) scene.setFill("pie", k, wedges.color[k]!);
    const canvas = renderCanvas(scene, "pie", S, S);

    const diff = diffPixels(webgl, canvas, { radius: 2, colorTolerance: 60 });
    // Two different rasterizers (SDF disc + angular discard vs a tessellated fan fill) land within a
    // couple of px along the disc rim and the radial wedge seams; the interiors must agree.
    expect(diff.fraction).toBeLessThan(0.1);

    device.destroy();
  });
});

describe("WebGLBackend pie layer", () => {
  it("renders a pie layer through the backend dispatch (setInstancedLayer)", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: W, height: H });

    backend.setInstancedLayer({
      name: "pies",
      primitive: "pie",
      pie: { centers: new Float32Array([32, 32, 32, 32]), radii: new Float32Array([16, 16]), angles: new Float32Array([0, 0.5, 0.5, 1]), colors: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), count: 2 },
      sizeMode: "world",
    });
    backend.setTransform({ k: 1, x: 0, y: 0 });

    const above = backend.readPixel(32, 44);
    const below = backend.readPixel(32, 20);
    expect((isRed(above) && isBlue(below)) || (isBlue(above) && isRed(below))).toBe(true);

    backend.removeInstancedLayer("pies");
    expect(backend.readPixel(32, 44)[3]).toBe(0); // gone after removal

    backend.destroy();
  });
});
