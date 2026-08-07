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
  translucentBorderedGlyphs,
  nestedRingShapes,
  roundedRectShapes,
  glyphSceneLayers,
  layerOf,
  renderWebGLBackend,
  renderCanvasBackend,
  renderSVG,
  diffPixels,
  type BackendRenderOptions,
  type DiffResult,
  type PixelBuffer,
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

describe("backend equivalence: bordered glyph encoding (#269)", () => {
  it("a TRANSLUCENT-fill bordered glyph composites identically on the instanced lane and its Scene twin", async () => {
    const backdrop = backdropScene(W, H);
    const { circles, scene } = translucentBorderedGlyphs(W, H);
    // Exactly how the engine splits the network across backends: WebGL draws the node glyphs
    // through the instanced circle lane (fill vs ring resolved per fragment, composited ONCE),
    // Canvas/SVG draw the traced Scene twin.
    const gl = await renderWebGLBackend([layerOf(backdrop, "backdrop")], W, H, {
      instanced: [{ name: "glyphs", primitive: "circles", circles }],
    });
    const sceneLayers = [layerOf(backdrop, "backdrop"), ...glyphSceneLayers(scene)];
    const cv = renderCanvasBackend(sceneLayers, W, H);
    const svg = await renderSVG(sceneLayers, W, H);

    // Sanity: an opaque backdrop ⇒ every pixel is compared, and the glyphs are ~20% of it, so a
    // lost/misplaced ring or a double-composited fill disc cannot hide under the threshold.
    const glCv = diffPixels(gl, cv);
    expect(glCv.considered).toBe(W * H);
    // The two Scene-path backends agree with each other…
    expect(diffPixels(cv, svg).fraction).toBeLessThan(0.01);
    // …and with the instanced lane. Measured 0 mismatching pixels of 40 000 — an OPAQUE ring over
    // a translucent fill composites each region exactly once on both encodings. The stacked-disc
    // encoding painted the fill disc OVER the border disc, so the whole inner disc (~(1−b)² ≈ 50%
    // of each glyph) read the ring colour through it: 12.1% of the frame, 12× over this bound.
    expect(glCv.fraction).toBeLessThan(0.01);
    expect(diffPixels(gl, svg).fraction).toBeLessThan(0.01);
  });
});

describe("backend equivalence: nested ring topology (#73)", () => {
  /** RGB at a pixel (the backdrop is opaque, so alpha is always 255 here). */
  const rgb = (buf: PixelBuffer, x: number, y: number): [number, number, number] => {
    const o = (Math.round(y) * buf.width + Math.round(x)) * 4;
    return [buf.data[o] ?? 0, buf.data[o + 1] ?? 0, buf.data[o + 2] ?? 0];
  };
  const near = (a: readonly number[], b: readonly number[]): boolean =>
    a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= 12);

  it("an island in a lake fills solid on all three backends", async () => {
    const backdrop = backdropScene(W, H);
    const scene = nestedRingShapes(W, H);
    const layers = [layerOf(backdrop, "backdrop"), layerOf(scene, "nested")];
    const gl = await renderWebGLBackend(layers, W, H);
    const cv = renderCanvasBackend(layers, W, H);
    const svg = await renderSVG(layers, W, H);

    // Deterministic signature: walk the concentric drawable outwards from its centre and
    // assert the fill ALTERNATES land / lake / island / pond on every backend. Canvas and SVG
    // get this from the native nonzero fill rule; WebGL has to recover it in `groupRings`.
    // Radii bracket the ring boundaries at 0.29/0.22/0.14/0.06 × min(W,H).
    const s = Math.min(W, H);
    const cx = W * 0.33;
    const cy = H * 0.36;
    const LAND: [number, number, number] = [31, 119, 180];
    const WATER: [number, number, number] = [255, 255, 255]; // the backdrop showing through
    const probes: { r: number; want: [number, number, number]; what: string }[] = [
      { r: s * 0.255, want: LAND, what: "land" },
      { r: s * 0.18, want: WATER, what: "lake" },
      { r: s * 0.1, want: LAND, what: "island in the lake" },
      { r: s * 0.03, want: WATER, what: "pond on the island" },
    ];
    for (const p of probes) {
      for (const [name, buf] of [["webgl", gl], ["canvas", cv], ["svg", svg]] as const) {
        // Two directions per radius, so a single stray triangle can't fake a pass.
        for (const [dx, dy] of [[1, 0], [-0.6, 0.8]] as const) {
          const got = rgb(buf, cx + dx * p.r, cy + dy * p.r);
          expect(near(got, p.want), `${name} @ ${p.what} (r=${p.r.toFixed(1)}): ${got}`).toBe(true);
        }
      }
    }

    // Cross-backend pixel diff: an opaque backdrop ⇒ every pixel is compared. Before #73 the
    // island/pond rings were classified as extra holes of the land, so earcut dropped the
    // overlapping-hole geometry and WebGL painted a materially different frame.
    const glCv = diffPixels(gl, cv);
    expect(glCv.considered).toBe(W * H);
    expect(diffPixels(cv, svg).fraction).toBeLessThan(0.01);
    expect(glCv.fraction).toBeLessThan(0.01);
    expect(diffPixels(gl, svg).fraction).toBeLessThan(0.01);
  });
});

describe("backend equivalence: arcTo rounded rectangles (#86)", () => {
  it("all three backends draw the same tangent-arc corners", async () => {
    const layers = [layerOf(backdropScene(W, H), "backdrop"), layerOf(roundedRectShapes(W, H), "bars")];
    const d = await threeWay(layers);
    expect(d.glCv.considered).toBe(W * H); // opaque backdrop ⇒ every pixel compared
    // A backend that squared a corner (the pre-#86 SvgPathContext two-lineTo path) leaves a
    // solid wedge of the wrong colour — orders of magnitude past the 1px position tolerance.
    expect(d.glCv.fraction).toBeLessThan(0.01);
    expect(d.cvSvg.fraction).toBeLessThan(0.01);
    expect(d.glSvg.fraction).toBeLessThan(0.01);
  });
});

describe("backend equivalence: cross-fade glyph compositing (#155 residual, pinned)", () => {
  it("faded instanced glyphs (WebGL) vs their Scene twin (Canvas/SVG): translucent-ring residual only", async () => {
    const backdrop = backdropScene(W, H);
    const { circles, scene } = fadedGlyphs(W, H);
    // WebGL draws the network LOD frontier through the instanced circle lane; Canvas/SVG
    // draw the traced Scene twin — exactly how the engine splits this across backends.
    const gl = await renderWebGLBackend([layerOf(backdrop, "backdrop")], W, H, {
      instanced: [{ name: "glyphs", primitive: "circles", circles }],
    });
    const sceneLayers = [layerOf(backdrop, "backdrop"), ...glyphSceneLayers(scene)];
    const cv = renderCanvasBackend(sceneLayers, W, H);
    const svg = await renderSVG(sceneLayers, W, H);

    // The two Scene-path backends agree tightly with each other.
    expect(diffPixels(cv, svg).fraction).toBeLessThan(0.01);

    // RESIDUAL #155 (was ~9.3%, now ~1.16% — measured). The ring encoding (#269) removed the
    // stacked-disc part: the fill disc no longer paints over a border disc, so the glyph's
    // interior composites exactly once, as the instanced lane does. What is left is inherent to
    // the fill+stroke encoding when BOTH are translucent: a circle's stroke straddles its path,
    // so the ring's inner half (`[r·(1−b), r·(1−b/2)]`, ~23% of the disc) lands ON the fill and
    // double-blends there — the #46 translucent-stroke residual in circle form, and the reason
    // that pin also sits at <0.02 rather than <0.01. A regression back to stacked discs scores
    // ~9%, so this ceiling is the guard; the sharp guard is the opaque-ring case above (<0.01).
    const glCv = diffPixels(gl, cv);
    const glSvg = diffPixels(gl, svg);
    expect(glCv.fraction).toBeLessThan(0.02);
    expect(glSvg.fraction).toBeLessThan(0.02);
  });
});
