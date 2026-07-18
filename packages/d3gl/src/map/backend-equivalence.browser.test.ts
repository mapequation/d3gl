import { describe, it, expect } from "vitest";
import type { RenderLayer } from "../core/index.js";
import { WebGLBackend } from "../webgl/webgl-backend.js";
import {
  overlappingBorderedShapes,
  strokeJoinShapes,
  backdropScene,
  textLabelScene,
  pointGlyphs,
  translucentFills,
  clippedShapes,
  fadedGlyphs,
  layerOf,
  renderWebGLBackend,
  renderCanvasBackend,
  renderSVG,
  diffPixels,
  type BackendRenderOptions,
  type DiffResult,
} from "./__tests__/backend-equivalence-harness.js";

const W = 200;
const H = 200;

/** A zoomed-in view: what separates screen sizeMode (constant px) from world (×k). */
const ZOOM = { k: 2, x: -W / 2, y: -H / 2 };

interface ThreeWayDiffs {
  glCv: DiffResult;
  cvSvg: DiffResult;
  glSvg: DiffResult;
}

/** Render the same layers through all three backends and diff every pair (#209). */
async function threeWay(layers: RenderLayer[], opts?: BackendRenderOptions): Promise<ThreeWayDiffs> {
  const gl = await renderWebGLBackend(layers, W, H, opts);
  const cv = renderCanvasBackend(layers, W, H, opts);
  const svg = await renderSVG(layers, W, H, opts);
  return { glCv: diffPixels(gl, cv), cvSvg: diffPixels(cv, svg), glSvg: diffPixels(gl, svg) };
}

describe("backend equivalence: overlapping bordered shapes (#41)", () => {
  it("all three backends composite overlapping fills/strokes identically", async () => {
    const scene = overlappingBorderedShapes(W, H);
    const d = await threeWay([layerOf(scene, "shapes")]);
    // Sanity: the scene must actually have rendered content in both backends.
    expect(d.glCv.considered).toBeGreaterThan(W * H * 0.2);
    // Equivalence (position-tolerant, so ~1px stroke-rasterizer differences don't count):
    // the draw-order bug leaves several-px-wide white border bands on WebGL that Canvas
    // occludes — far wider than the 1px tolerance, so it scores many percent and fails.
    // Once WebGL composites in painter's order, only a handful of pixels differ (<0.5%).
    expect(d.glCv.fraction).toBeLessThan(0.01);
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    expect(d.glSvg.fraction).toBeLessThan(0.01);
  });

  it("all three backends stroke joins identically (miter + limit)", async () => {
    const scene = strokeJoinShapes(W, H, { join: "miter" });
    const d = await threeWay([layerOf(scene, "lines")]);
    expect(d.glCv.considered).toBeGreaterThan(W * H * 0.05);
    // WebGL beveled every corner while Canvas miters them — sharp corners add several-px
    // pointed regions far wider than the 1px tolerance. Passes once WebGL miters with the
    // same limit and Canvas/SVG are pinned to that limit + miter join + butt caps.
    expect(d.glCv.fraction).toBeLessThan(0.01);
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    expect(d.glSvg.fraction).toBeLessThan(0.01);
  });

  it("all three backends draw round caps identically", async () => {
    const scene = strokeJoinShapes(W, H, { cap: "round" });
    const d = await threeWay([layerOf(scene, "lines")]);
    expect(d.glCv.considered).toBeGreaterThan(W * H * 0.05);
    // WebGL tessellates the round cap into a fan; Canvas/SVG draw a true arc. The
    // position-tolerant diff absorbs the sub-pixel chord error; a missing cap (butt
    // vs round) would leave a half-disc-sized mismatch well over the threshold.
    expect(d.glCv.fraction).toBeLessThan(0.01);
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    expect(d.glSvg.fraction).toBeLessThan(0.01);
  });

  it("all three backends draw round joins identically", async () => {
    const scene = strokeJoinShapes(W, H, { join: "round" });
    const d = await threeWay([layerOf(scene, "lines")]);
    expect(d.glCv.considered).toBeGreaterThan(W * H * 0.05);
    // WebGL's arc-fan round join vs the native round joins — sub-pixel chord error
    // only. A miter/bevel fallback at sharp corners would leave a multi-px divergence.
    expect(d.glCv.fraction).toBeLessThan(0.01);
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    expect(d.glSvg.fraction).toBeLessThan(0.01);
  });
});

describe("backend equivalence: text labels (#209)", () => {
  it("Canvas and SVG rasterize the setTextLayer labels identically", async () => {
    const { scene, texts } = textLabelScene(W, H);
    const layers = [layerOf(scene, "bg")];
    const cv = renderCanvasBackend(layers, W, H, { texts });
    const svg = await renderSVG(layers, W, H, { texts });

    // Sanity: the labels contribute measurable ink on BOTH backends (guards against a
    // silently dropped text layer making the cross-backend diff trivially pass).
    const cvNoText = renderCanvasBackend(layers, W, H);
    const svgNoText = await renderSVG(layers, W, H);
    expect(diffPixels(cv, cvNoText).fraction).toBeGreaterThan(0.005);
    expect(diffPixels(svg, svgNoText).fraction).toBeGreaterThan(0.005);

    // Same engine rasterizes both (fillText vs <text>): only glyph AA differs (~0.003%
    // measured; the labels' ink is ~5.6% of the frame, so a wrong/missing label is
    // orders of magnitude over this bound).
    expect(diffPixels(cv, svg).fraction).toBeLessThan(0.01);
  });

  // The WebGL leg of the 3-way activates once the backend grows its setTextLayer seam
  // (#219): toPNG() then composites the stashed labels via the same 2D painter Canvas
  // uses, so the export must pixel-match the Canvas render. Skipped (not failed) until
  // that lands — runIf keys on the seam itself.
  it.runIf("setTextLayer" in WebGLBackend.prototype)(
    "WebGL export composites the labels equivalently (#219 seam present)",
    async () => {
      const { scene, texts } = textLabelScene(W, H);
      const layers = [layerOf(scene, "bg")];
      const gl = await renderWebGLBackend(layers, W, H, { texts });
      const cv = renderCanvasBackend(layers, W, H, { texts });
      const svg = await renderSVG(layers, W, H, { texts });
      expect(diffPixels(gl, cv).fraction).toBeLessThan(0.01);
      expect(diffPixels(gl, svg).fraction).toBeLessThan(0.01);
    },
  );
});

describe("backend equivalence: point glyphs (#209)", () => {
  it("world sizeMode: circle glyphs scale with zoom identically on all three backends", async () => {
    const scene = pointGlyphs(W, H);
    const d = await threeWay([layerOf(scene, "points")], { transform: ZOOM });
    expect(d.glCv.considered).toBeGreaterThan(W * H * 0.05);
    expect(d.glCv.fraction).toBeLessThan(0.01);
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    expect(d.glSvg.fraction).toBeLessThan(0.01);
  });

  it("screen sizeMode: constant-px glyphs at projected centres match on all three backends", async () => {
    const scene = pointGlyphs(W, H);
    const d = await threeWay([layerOf(scene, "points", { sizeMode: "screen" })], { transform: ZOOM });
    // Screen mode halves the rendered area vs the world case (radii stay constant while
    // the view zooms ×2) — that shrink is itself asserted: a sizeMode regression that
    // rendered world-sized discs would pass the world thresholds instead.
    expect(d.glCv.considered).toBeGreaterThan(W * H * 0.02);
    expect(d.glCv.considered).toBeLessThan(W * H * 0.05);
    expect(d.glCv.fraction).toBeLessThan(0.01);
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    expect(d.glSvg.fraction).toBeLessThan(0.01);
  });
});

describe("backend equivalence: translucency (#209)", () => {
  it("overlapping translucent fills composite identically on all three backends", async () => {
    const backdrop = backdropScene(W, H);
    const scene = translucentFills(W, H);
    const d = await threeWay([layerOf(backdrop, "backdrop"), layerOf(scene, "fills")]);
    expect(d.glCv.considered).toBe(W * H); // opaque backdrop ⇒ every pixel compared
    expect(d.glCv.fraction).toBeLessThan(0.01);
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    expect(d.glSvg.fraction).toBeLessThan(0.01);
  });

  it("translucent strokes: Canvas↔SVG exact; WebGL self-overlap divergence pinned (#46)", async () => {
    const backdrop = backdropScene(W, H);
    const scene = strokeJoinShapes(W, H, {
      join: "miter", // most visible per #46
      colors: ["rgba(31, 119, 180, 0.5)", "rgba(214, 39, 40, 0.5)", "rgba(44, 160, 44, 0.5)"],
    });
    const d = await threeWay([layerOf(backdrop, "backdrop"), layerOf(scene, "lines")]);
    // Canvas and SVG both rasterize each stroke to a single coverage mask → tight match.
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    // KNOWN DIVERGENCE #46 (pinned, not skipped): WebGL's tessellated stroke double-blends
    // where its own segment quads overlap (inner side of turns), rendering darker than the
    // single-coverage Canvas/SVG stroke. Measured ~1.1% of the full opaque frame here
    // (this scene diffs every backdrop pixel; #46's ~0.4% was over content pixels only).
    // The ceiling fails if the residual regresses (e.g. joins start stacking again);
    // tighten it to the usual <0.01 when #46 is fixed.
    expect(d.glCv.fraction).toBeLessThan(0.02);
    expect(d.glSvg.fraction).toBeLessThan(0.02);
  });
});

describe("backend equivalence: clipped layer (#209)", () => {
  it("SVG <clipPath>, Canvas clip() and the WebGL stencil cut content identically", async () => {
    const scene = clippedShapes(W, H);
    const layers = [layerOf(scene, "mask"), layerOf(scene, "content", { clipTo: "mask" })];
    const d = await threeWay(layers);
    expect(d.glCv.considered).toBeGreaterThan(W * H * 0.2);
    // A leak (unclipped bar/disc parts) is a multi-px region far over these bounds.
    expect(d.glCv.fraction).toBeLessThan(0.01);
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    expect(d.glSvg.fraction).toBeLessThan(0.01);
  });
});

describe("backend equivalence: cross-fade glyph compositing (#155, pinned)", () => {
  it("faded instanced glyphs (WebGL) vs their Scene twin (Canvas/SVG): divergence pinned", async () => {
    const backdrop = backdropScene(W, H);
    const { circles, scene } = fadedGlyphs(W, H);
    // WebGL draws the network LOD frontier through the instanced circle lane; Canvas/SVG
    // draw the traced Scene twin — exactly how the engine splits this across backends.
    const gl = await renderWebGLBackend([layerOf(backdrop, "backdrop")], W, H, {
      instanced: [{ name: "glyphs", primitive: "circles", circles }],
    });
    const sceneLayers = [
      layerOf(backdrop, "backdrop"),
      layerOf(scene, "glyph-borders"),
      layerOf(scene, "glyph-fills"),
    ];
    const cv = renderCanvasBackend(sceneLayers, W, H);
    const svg = await renderSVG(sceneLayers, W, H);

    // The two Scene-path backends agree tightly with each other.
    expect(diffPixels(cv, svg).fraction).toBeLessThan(0.01);

    // KNOWN DIVERGENCE #155 (pinned, not skipped): the instanced lane composites the whole
    // glyph ONCE at the fade alpha, while the Scene twin stacks border disc + fill disc —
    // the fill region composites twice and reads darker on Canvas/SVG. Measured ~9.3% of
    // the frame (the glyphs' fill regions). The floor asserts the divergence (and this
    // test's sensitivity to it) still exists — when #155 is fixed, it should trip and this
    // pin should tighten to the usual <0.01. The ceiling fails if compositing drifts further.
    const glCv = diffPixels(gl, cv);
    const glSvg = diffPixels(gl, svg);
    expect(glCv.fraction).toBeGreaterThan(0.02);
    expect(glCv.fraction).toBeLessThan(0.25);
    expect(glSvg.fraction).toBeGreaterThan(0.02);
    expect(glSvg.fraction).toBeLessThan(0.25);
  });
});
