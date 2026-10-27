import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter, WebGLDevice } from "@luma.gl/webgl";
import { Scene } from "../core/index.js";
import type { InstancedCirclesData, RenderLayer } from "../core/index.js";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";
import { pickAt } from "./pick.js";
import { toPNG } from "./png.js";
import { WebGLBackend } from "./webgl-backend.js";
import { CanvasBackend } from "../canvas/canvas-backend.js";
import { decodeImage, withDevicePixelRatio, type PixelBuffer } from "../map/__tests__/backend-equivalence-harness.js";

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

function twoHalves() {
  const scene = new Scene();
  scene.group("cells", (g) => {
    g.drawable("a", (ctx) => ctx.rect(0, 0, W / 2, H));
    g.drawable("b", (ctx) => ctx.rect(W / 2, 0, W / 2, H));
  });
  return scene;
}

describe("pickAt", () => {
  it("returns the drawableId under a top-left-origin screen pixel", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    expect(pickAt(device, renderer, framebuffer, 16, 32, H)).toBe(0); // left -> "a"
    expect(pickAt(device, renderer, framebuffer, 48, 32, H)).toBe(1); // right -> "b"
    expect(pickAt(device, renderer, framebuffer, 16, 2, H)).toBe(0); // still over a near top

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});

describe("toPNG", () => {
  it("produces a PNG data URL from the rendered framebuffer", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    const url = toPNG(device, framebuffer, W, H);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url.length).toBeGreaterThan(100);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });

});

/** A translucent link-like fill, a stroked polyline (MSAA-smoothed edges) and two discs (shader-covered edges). */
function exportScene(w: number, h: number): { layers: RenderLayer[]; circles: InstancedCirclesData } {
  const scene = new Scene();
  scene.group("shapes", (g) => {
    g.drawable("band", (ctx) => {
      ctx.moveTo(w * 0.1, h * 0.2);
      ctx.lineTo(w * 0.9, h * 0.35);
      ctx.lineTo(w * 0.9, h * 0.45);
      ctx.lineTo(w * 0.1, h * 0.3);
      ctx.closePath();
    });
    g.drawable("line", (ctx) => {
      ctx.moveTo(w * 0.15, h * 0.85);
      ctx.lineTo(w * 0.5, h * 0.6);
      ctx.lineTo(w * 0.85, h * 0.9);
    }, { lineWidth: 3 });
  });
  scene.setFill("shapes", "band", "rgba(40, 90, 161, 0.9)");
  scene.setFill("shapes", "line", "rgba(0, 0, 0, 0)");
  scene.setStroke("shapes", "line", "#d62728");
  const circles: InstancedCirclesData = {
    centers: new Float32Array([w * 0.3 + 0.3, h * 0.62 + 0.2, w * 0.7 + 0.1, h * 0.6 + 0.4]),
    radii: new Float32Array([9.4, 5.7]),
    colors: new Uint8Array([44, 160, 44, 255, 255, 127, 14, 200]),
    count: 2,
  };
  return { layers: [{ name: "shapes", buffers: scene.buffers("shapes"), drawables: scene.drawables("shapes") }], circles };
}

const EW = 120;
const EH = 90;

describe("WebGLBackend.toPNG() exports the canvas as drawn (#569)", () => {
  for (const ratio of [1, 2]) {
    it(`at devicePixelRatio ${ratio}: the canvas's size, and every pixel the screen's`, async () => {
      const canvas = document.createElement("canvas");
      canvas.width = EW;
      canvas.height = EH;
      const { url, screen } = await withDevicePixelRatio(ratio, async () => {
        const backend = await WebGLBackend.create(canvas, { width: EW, height: EH });
        const { layers, circles } = exportScene(EW, EH);
        backend.setLayers(layers);
        backend.setInstancedLayer({ name: "nodes", primitive: "circles", circles });
        backend.setTransform({ k: 1, x: 0, y: 0 });
        const png = backend.toPNG();
        // The screen, as the browser composites it: the drawing buffer toPNG() drew, premultiplied, bottom-up,
        // read in the same task.
        const device = backend.gpuDevice;
        if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL device");
        const gl = device.gl;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        const pixels = new Uint8Array(EW * ratio * EH * ratio * 4);
        gl.readPixels(0, 0, EW * ratio, EH * ratio, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        backend.destroy();
        return { url: png, screen: pixels };
      });
      // decodeImage(…, exact) throws unless the export is the drawing buffer's size, not the CSS size.
      const exported = await decodeImage(url, EW * ratio, EH * ratio, true);

      const { worst, translucent, partial, first } = compareToScreen(exported, screen);
      // Non-vacuous: the band's translucent interior and antialiased edges are in the frame.
      expect(translucent).toBeGreaterThan(100 * ratio * ratio);
      expect(partial).toBeGreaterThan(50 * ratio);
      // Premultiplied, every exported pixel is the screen's to the PNG's rounding.
      expect(worst, first).toBeLessThanOrEqual(1);
      // And straight, the band's colour is its own: (40, 90, 161, 230), not RGB × alpha (36, 81, 145).
      const o = (Math.round(EH * ratio * 0.32) * EW * ratio + Math.round(EW * ratio * 0.5)) * 4;
      expect([...exported.data.slice(o, o + 4)].map((v, i) => Math.abs(v - [40, 90, 161, 230][i]!) <= 1)).toEqual([true, true, true, true]);
    });
  }

  it("has a Canvas export's size at the same view, and paints labels where the screen shows them", async () => {
    const ratio = 2;
    const label = { x: 60, y: 20, text: "Label", font: "bold 12px sans-serif", color: "#000", align: "middle" as const };
    const glCanvas = document.createElement("canvas");
    glCanvas.width = EW;
    glCanvas.height = EH;
    const png = await withDevicePixelRatio(ratio, async () => {
      const backend = await WebGLBackend.create(glCanvas, { width: EW, height: EH });
      backend.setTextLayer([label]);
      const url = backend.toPNG();
      backend.destroy();
      return url;
    });
    const gl = await decodeImage(png, EW * ratio, EH * ratio, true);

    const cvCanvas = document.createElement("canvas");
    cvCanvas.width = EW * ratio;
    cvCanvas.height = EH * ratio;
    const canvasBackend = new CanvasBackend(cvCanvas, EW, EH);
    canvasBackend.setTextLayer([label]);
    canvasBackend.render();
    const cv = await decodeImage(canvasBackend.toPNG(), EW * ratio, EH * ratio, true);
    canvasBackend.destroy();

    // Both exports are the device-px size (the exact decode checks it), and the label's ink sits at its
    // CSS anchor × devicePixelRatio on both: the painter runs under the same scale.
    const glInk = inkCentre(gl);
    const cvInk = inkCentre(cv);
    expect(Math.abs(glInk.x - label.x * ratio)).toBeLessThan(3);
    expect(Math.abs(glInk.y - label.y * ratio)).toBeLessThan(3);
    expect(Math.abs(glInk.x - cvInk.x)).toBeLessThan(1);
    expect(Math.abs(glInk.y - cvInk.y)).toBeLessThan(1);
  });

  it("exports a hidden chart at its size: the canvas's 1×1 buffer is sized first", async () => {
    // A canvas with no layout box (display: none, or not in the document) gets a 1×1 drawing buffer from
    // luma's resize observer, a frame after it starts observing.
    const canvas = document.createElement("canvas");
    canvas.width = EW;
    canvas.height = EH;
    const backend = await WebGLBackend.create(canvas, { width: EW, height: EH });
    const { layers } = exportScene(EW, EH);
    backend.setLayers(layers);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    backend.render();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    backend.render();
    expect(canvas.width, "non-vacuous: the observer shrank the hidden canvas").toBe(1);
    const img = await decodeImage(backend.toPNG(), EW, EH, true);
    backend.destroy();
    const o = (Math.round(EH * 0.32) * EW + Math.round(EW * 0.5)) * 4;
    expect(img.data[o + 3], "the band is drawn").toBe(230);
  });
});

/** The export (straight alpha, top-down) against the screen's drawing buffer (premultiplied, bottom-up):
 *  the largest premultiplied channel difference, and how many pixels are translucent or partly covered. */
function compareToScreen(exported: PixelBuffer, screen: Uint8Array): { worst: number; translucent: number; partial: number; first: string } {
  const { width, height, data } = exported;
  let worst = 0, translucent = 0, partial = 0, first = "";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const e = (y * width + x) * 4;
      const s = ((height - 1 - y) * width + x) * 4;
      const a = data[e + 3]!;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(Math.round((data[e + c]! * a) / 255) - screen[s + c]!));
      worst = Math.max(worst, Math.abs(a - screen[s + 3]!));
      if (!first && worst > 1) first = `(${x},${y}) export ${[...data.slice(e, e + 4)]} screen ${[...screen.slice(s, s + 4)]}`;
      if (a >= 228 && a <= 232) translucent++;
      else if (a > 0 && a < 255) partial++;
    }
  }
  return { worst, translucent, partial, first };
}

/** The alpha-weighted centre of an image's ink. */
function inkCentre(img: PixelBuffer): { x: number; y: number } {
  let m = 0, mx = 0, my = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = img.data[(y * img.width + x) * 4 + 3]!;
      m += a;
      mx += a * (x + 0.5);
      my += a * (y + 0.5);
    }
  }
  return { x: mx / m, y: my / m };
}
