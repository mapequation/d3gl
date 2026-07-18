import { describe, it, expect } from "vitest";
import type { TextData } from "../core/index.js";
import { WebGLBackend } from "../webgl/webgl-backend.js";
import { CanvasBackend } from "../canvas/canvas-backend.js";
import {
  overlappingBorderedShapes,
  layerOf,
  diffPixels,
  type PixelBuffer,
} from "./__tests__/backend-equivalence-harness.js";

const W = 200;
const H = 200;

// Big, bold, haloed labels so their pixels are a clearly measurable share of the export:
// one over the shapes (probes compositing on top of geometry), one over transparent background.
const TEXTS: TextData[] = [
  { x: W / 2, y: 30, text: "Alpha", font: "600 18px sans-serif", color: "#111111", halo: { color: "#ffffff", width: 2 }, align: "middle" },
  { x: 12, y: H - 16, text: "beta", font: "16px sans-serif", color: "#d62728", align: "start", opacity: 0.8 },
];

/** Decode a PNG data URL into a top-left-origin RGBA buffer (the harness's PixelBuffer). */
async function decodePNG(url: string): Promise<PixelBuffer> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("PNG decode failed"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: new Uint8Array(data.data.buffer.slice(0)) };
}

async function makeWebGL(): Promise<WebGLBackend> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  return WebGLBackend.create(canvas, { width: W, height: H });
}

function makeCanvas(): CanvasBackend {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  return new CanvasBackend(canvas, W, H);
}

// #219: WebGL toPNG()/toSVG() must include the placed labels, matching Canvas/SVG exports
// (unified rendering). The WebGL backend stashes the TextData set (export-only — the live
// screen keeps the HTML overlay) and composites it at export time.
describe("WebGL export includes labels (#219)", () => {
  it("toPNG composites the stashed labels and pixel-matches the Canvas export; without them it diverges (the bug)", async () => {
    const scene = overlappingBorderedShapes(W, H);

    const gl = await makeWebGL();
    gl.setLayers([layerOf(scene, "shapes")]);
    gl.setTransform({ k: 1, x: 0, y: 0 });
    const glWithout = await decodePNG(gl.toPNG()); // pre-#219 behavior: no labels in the export
    gl.setTextLayer(TEXTS);
    const glWith = await decodePNG(gl.toPNG());
    gl.destroy();

    const cv = makeCanvas();
    cv.setLayers([layerOf(scene, "shapes")]);
    cv.setTransform({ k: 1, x: 0, y: 0 });
    cv.setTextLayer(TEXTS);
    const cvPng = await decodePNG(cv.toPNG());
    cv.destroy();

    // The bug (#219): a label-less WebGL export fails the very equivalence bound the fix meets —
    // every label pixel Canvas drew is a mismatch.
    const missing = diffPixels(glWithout, cvPng);
    expect(missing.fraction).toBeGreaterThan(0.01);

    // The fix: with the stash composited, the exports are equivalent within the harness's
    // position-tolerant bound (same threshold as the shape-only backend-equivalence cases).
    const fixed = diffPixels(glWith, cvPng);
    expect(fixed.considered).toBeGreaterThan(W * H * 0.2); // sanity: both actually rendered
    expect(fixed.fraction).toBeLessThan(0.01);
  });

  it("toSVG emits exactly the <text> elements the Canvas/SVG serializer emits", async () => {
    const scene = overlappingBorderedShapes(W, H);

    const gl = await makeWebGL();
    gl.setLayers([layerOf(scene, "shapes")]);
    gl.setTransform({ k: 1, x: 0, y: 0 });
    gl.setTextLayer(TEXTS);
    const glSvg = gl.toSVG();
    gl.destroy();

    const cv = makeCanvas();
    cv.setLayers([layerOf(scene, "shapes")]);
    cv.setTransform({ k: 1, x: 0, y: 0 });
    cv.setTextLayer(TEXTS);
    const cvSvg = cv.toSVG();
    cv.destroy();

    const textsOf = (svg: string) => svg.match(/<text[^>]*>[^<]*<\/text>/g) ?? [];
    const glTexts = textsOf(glSvg);
    expect(glTexts).toHaveLength(2);
    // Same serializer (serializeTexts) on both backends ⇒ byte-identical <text> elements.
    expect(glTexts).toEqual(textsOf(cvSvg));
    // Position/content/font/fill/halo/opacity all present on the serialized elements.
    expect(glTexts[0]).toContain(`x="${W / 2}"`);
    expect(glTexts[0]).toContain('text-anchor="middle"');
    expect(glTexts[0]).toContain("font:600 18px sans-serif");
    expect(glTexts[0]).toContain('fill="#111111"');
    expect(glTexts[0]).toContain('paint-order="stroke"'); // halo
    expect(glTexts[0]).toContain(">Alpha<");
    expect(glTexts[1]).toContain('opacity="0.800"');
  });

  it("setTextLayer is an export-only stash: the live WebGL frame stays label-free (overlay owns the screen)", async () => {
    const scene = overlappingBorderedShapes(W, H);
    const gl = await makeWebGL();
    gl.setLayers([layerOf(scene, "shapes")]);
    gl.setTransform({ k: 1, x: 0, y: 0 });
    gl.setTextLayer(TEXTS);
    gl.render();

    expect(gl.textLayerMode).toBe("export-only");
    // The "beta" label sits over transparent background; on the LIVE frame nothing may be
    // drawn there (labels are the HTML overlay's job — the stash must not touch the screen).
    const px = gl.readScreenPixel(16, H - 16);
    expect(px[3]).toBe(0);
    gl.destroy();
  });
});
