/**
 * #45 — curves are flattened ONCE at build time, in WORLD units, at the Scene's fixed
 * tolerance (0.25). Zooming only scales the baked polyline, so a facet that measured
 * 0.25 world units measures 0.25·k screen px: at k = 40 an arc rim shows ~8px flats.
 *
 * `curveTolerance` is the engine-level knob that lets a chart declare how fine the bake
 * must be. It changes nothing per frame — it only refines the geometry recorded once, at
 * layer-registration time (see the PR's Performance section for the vertex/memory cost).
 *
 * Both legs render the SAME world geometry through the SAME rasterizer (the Canvas
 * backend), so the diff's noise floor is the anti-aliased edge only — a facet is the only
 * thing that can move a pixel. The ground truth is the same chart baked 400× finer, i.e.
 * a sub-0.03px facet at the test zoom: an "analytically round" circle for this raster.
 */
import { describe, it, expect } from "vitest";
import { rgb } from "d3-color";
import type { PathContext } from "../core/index.js";
import { plot, type Plot } from "./plot.js";
import type { BackendType } from "./backend-factory.js";
import { diffPixels, type PixelBuffer } from "./__tests__/backend-equivalence-harness.js";

const W = 300;
const H = 300;
/** Zoom the bake must survive. Matches the website ancestral-ranges `enableZoom([0.5, 40])`. */
const K = 40;
/** World-space disc: radius 1.5 → 60px on screen at k = 40 (comfortably inside the viewport). */
const CX = 4;
const CY = 4;
const R = 1.5;
/** Centre the disc: screen = k·world + t. */
const TRANSFORM = { k: K, x: W / 2 - K * CX, y: H / 2 - K * CY };

interface Chart {
  pixels: PixelBuffer;
  svg: string;
  destroy: () => void;
}

/** A one-drawable chart holding a full-circle arc, rendered at {@link TRANSFORM}. */
async function discChart(curveTolerance?: number): Promise<Chart> {
  const host = document.createElement("div");
  host.style.width = `${W}px`;
  host.style.height = `${H}px`;
  document.body.appendChild(host);
  const chart = plot(host, { width: W, height: H, backend: "canvas", curveTolerance });
  await chart.whenReady();
  chart.layer("disc", [0], {
    draw: (ctx: PathContext) => {
      ctx.moveTo(CX + R, CY);
      ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.closePath();
    },
    fill: "rgb(0,0,0)",
    id: () => "d",
  });
  chart.setTransform(TRANSFORM);
  const svg = chart.toSVG();
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("no canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    pixels: { width: canvas.width, height: canvas.height, data: new Uint8Array(img.data.buffer.slice(0)) },
    svg,
    destroy: () => {
      chart.destroy();
      host.remove();
    },
  };
}

/** Vertex count of the exported disc path — the deterministic signature of the bake. */
function pathVertices(svg: string): number {
  const d = /<path[^>]*\sd="([^"]+)"/.exec(svg)?.[1];
  if (!d) throw new Error(`no <path d> in export: ${svg.slice(0, 400)}`);
  return (d.match(/[ML]/g) ?? []).length;
}

describe("#45 curveTolerance refines the build-time curve bake", () => {
  it("a default-baked arc is visibly faceted at k=40; curveTolerance removes it", async () => {
    // Ground truth: baked 400× finer than the default → 0.024px facets at k = 40.
    const truth = await discChart(0.25 / 400);
    const coarse = await discChart(); // today's default: 0.25 world units
    const fine = await discChart(0.25 / K); // declared for this chart's max zoom

    // Same rasterizer both sides, so radius 1 absorbs only the anti-aliased edge; an
    // 8px facet has no match anywhere near it.
    const coarseDiff = diffPixels(coarse.pixels, truth.pixels, { radius: 1 });
    const fineDiff = diffPixels(fine.pixels, truth.pixels, { radius: 1 });
    // eslint-disable-next-line no-console
    console.log(
      `[#45] verts coarse=${pathVertices(coarse.svg)} fine=${pathVertices(fine.svg)} truth=${pathVertices(truth.svg)} | ` +
        `mismatch coarse=${coarseDiff.fraction.toFixed(4)} fine=${fineDiff.fraction.toFixed(4)}`,
    );

    // The defect: the default bake is a hexagon at this radius — >5% of the disc's ink is
    // in the wrong place. (Guards the fixture too: if this ever drops, the test went vacuous.)
    expect(coarseDiff.fraction).toBeGreaterThan(0.05);
    // The fix: sub-pixel facets at the declared zoom.
    expect(fineDiff.fraction).toBeLessThan(0.01);
    // Deterministic signature: the refinement happens in the BAKE (more recorded vertices),
    // not per frame. Arc segment count scales as 1/sqrt(tolerance) → sqrt(40) ≈ 6.3×.
    expect(pathVertices(fine.svg)).toBeGreaterThan(pathVertices(coarse.svg) * 4);

    truth.destroy();
    coarse.destroy();
    fine.destroy();
  });

  it("omitting curveTolerance keeps today's bake exactly", async () => {
    const a = await discChart();
    const b = await discChart(0.25);
    expect(pathVertices(a.svg)).toBe(pathVertices(b.svg));
    a.destroy();
    b.destroy();
  });
});

// ---------------------------------------------------------------------------------------------
// #283 — the tolerance is per DRAWABLE: an anchored screen-sizeMode glyph is drawn as
// `anchor′ + (p − anchor)`, so its recorded offsets are PIXELS and the zoom never scales them.
// Refining it buys nothing; only world-scaled curves (incl. an unanchored screen layer) facet.
// ---------------------------------------------------------------------------------------------

/** A constant-pixel glyph radius — the website ancestral-ranges `SCREEN_PIE_R`. */
const GLYPH_R = 8;
/** One colour per layer, so a vertex count can be read back PER LAYER from the export. */
const GLYPH_FILL = "#ff0000";
const WORLD_FILL = "#0000ff";
const UNANCHORED_FILL = "#008000";
const ANCHORED_WORLD_FILL = "#ff00ff";
const ANCHORED_DEFAULT_FILL = "#00ffff";

function fullCircle(ctx: PathContext, cx: number, cy: number, r: number): void {
  ctx.moveTo(cx + r, cy);
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
}

async function mountPlot(backend: BackendType, curveTolerance: number | undefined, build: (chart: Plot) => void) {
  const host = document.createElement("div");
  host.style.width = `${W}px`;
  host.style.height = `${H}px`;
  document.body.appendChild(host);
  const chart = plot(host, { width: W, height: H, backend, curveTolerance });
  await chart.whenReady();
  build(chart);
  chart.setTransform(TRANSFORM);
  return {
    chart,
    host,
    destroy: () => {
      chart.destroy();
      host.remove();
    },
  };
}

/** The ancestral-ranges mix in one engine: an anchored screen glyph, a world curve, and an
 *  UNANCHORED screen-sizeMode curve (world-scaled geometry that does want the fine bake). Plus
 *  the two anchored layers the floor must NOT touch — `sizeMode: "world"` and sizeMode omitted
 *  (which means world): there the anchor is ignored and the drawable is world-scaled, as in the
 *  ancestral-ranges `coords: "world"` pies. They pin the engine's predicate to `=== "screen"`. */
function mixedLayers(chart: Plot): void {
  chart.layer("glyph", [0], {
    draw: (ctx: PathContext) => fullCircle(ctx, CX, CY, GLYPH_R),
    anchor: () => [CX, CY],
    sizeMode: "screen",
    fill: GLYPH_FILL,
    id: () => "g",
  });
  chart.layer("world", [0], { draw: (ctx: PathContext) => fullCircle(ctx, CX, CY, R), fill: WORLD_FILL, id: () => "w" });
  chart.layer("unanchored", [0], {
    draw: (ctx: PathContext) => fullCircle(ctx, CX, CY, R / 2),
    sizeMode: "screen",
    fill: UNANCHORED_FILL,
    id: () => "u",
  });
  chart.layer("anchoredWorld", [0], {
    draw: (ctx: PathContext) => fullCircle(ctx, CX, CY, R),
    anchor: () => [CX, CY],
    sizeMode: "world",
    fill: ANCHORED_WORLD_FILL,
    id: () => "aw",
  });
  chart.layer("anchoredDefault", [0], {
    draw: (ctx: PathContext) => fullCircle(ctx, CX, CY, R),
    anchor: () => [CX, CY],
    fill: ANCHORED_DEFAULT_FILL,
    id: () => "ad",
  });
}

/**
 * Recorded vertices per layer (keyed by fill) across EVERY `<path>` of an export. Reading only the
 * first `<path d>` is not a per-layer count: the SVG serializer emits a screen layer's anchored
 * glyphs in a separate untransformed block after all world groups.
 */
function verticesByFill(svg: string): Map<string, number> {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const out = new Map<string, number>();
  for (const p of Array.from(doc.querySelectorAll("path"))) {
    const fill = p.getAttribute("fill");
    if (!fill || fill === "none") continue;
    const key = rgb(fill).formatHex();
    out.set(key, (out.get(key) ?? 0) + (p.getAttribute("d")?.match(/[ML]/g) ?? []).length);
  }
  return out;
}

async function mixedCounts(backend: BackendType, curveTolerance?: number): Promise<Map<string, number>> {
  const m = await mountPlot(backend, curveTolerance, mixedLayers);
  const counts = verticesByFill(m.chart.toSVG());
  m.destroy();
  return counts;
}

describe("#283 anchored screen glyphs are exempt from curveTolerance", () => {
  for (const backend of ["webgl", "canvas", "svg"] as const) {
    it(`${backend}: the glyph keeps the default count while world-scaled curves refine`, async () => {
      const base = await mixedCounts(backend);
      const fine = await mixedCounts(backend, 0.25 / K);
      // eslint-disable-next-line no-console
      console.log(`[#283 ${backend}] default ${JSON.stringify([...base])} | 0.25/${K} ${JSON.stringify([...fine])}`);
      // Guard the fixture: every layer exported something (else the equalities below are vacuous).
      for (const fill of [GLYPH_FILL, WORLD_FILL, UNANCHORED_FILL, ANCHORED_WORLD_FILL, ANCHORED_DEFAULT_FILL]) {
        expect(base.get(fill) ?? 0).toBeGreaterThan(4);
      }

      // The acceptance criterion: same vertex count as at the default…
      expect(fine.get(GLYPH_FILL)).toBe(base.get(GLYPH_FILL));
      // …while world-sizeMode geometry in the SAME engine refines (~6.3× at 0.25/40)…
      expect(fine.get(WORLD_FILL) ?? 0).toBeGreaterThan((base.get(WORLD_FILL) ?? 0) * 4);
      // …and so does an unanchored screen layer: the predicate is per drawable, not per sizeMode.
      expect(fine.get(UNANCHORED_FILL) ?? 0).toBeGreaterThan((base.get(UNANCHORED_FILL) ?? 0) * 4);
      // …and an ANCHORED drawable refines too unless its layer is screen-sized: in world sizeMode
      // (explicit or omitted) the anchor is ignored and the glyph scales with the zoom.
      expect(fine.get(ANCHORED_WORLD_FILL) ?? 0).toBeGreaterThan((base.get(ANCHORED_WORLD_FILL) ?? 0) * 4);
      expect(fine.get(ANCHORED_DEFAULT_FILL) ?? 0).toBeGreaterThan((base.get(ANCHORED_DEFAULT_FILL) ?? 0) * 4);
    });
  }

  /** A black anchored screen glyph, rendered through Canvas at `transform`. */
  const glyphAt = (curveTolerance: number | undefined, transform: { k: number; x: number; y: number }) =>
    mountPlot("canvas", curveTolerance, (chart) =>
      chart.layer("glyph", [0], {
        draw: (ctx: PathContext) => fullCircle(ctx, CX, CY, GLYPH_R),
        anchor: () => [CX, CY],
        sizeMode: "screen",
        fill: "rgb(0,0,0)",
        id: () => "g",
      }),
    ).then((m) => {
      m.chart.setTransform(transform);
      return m;
    });
  /** The same screen spot as {@link TRANSFORM}'s anchor, at k = 1. */
  const AT_K1 = { k: 1, x: W / 2 - CX, y: H / 2 - CY };

  it("at k=40 under 0.25/40 the glyph draws exactly the pixels of a default chart at k=1", async () => {
    // What the exemption promises, in pixels: a chart that declares its deep zoom draws its
    // anchored glyphs EXACTLY as the default chart does — at any zoom, since the offsets are px.
    const fine = await glyphAt(0.25 / K, TRANSFORM);
    const base = await glyphAt(undefined, AT_K1);
    const diff = diffPixels(canvasPixels(fine.host), canvasPixels(base.host), { radius: 0, colorTolerance: 2 });
    // eslint-disable-next-line no-console
    console.log(`[#283] glyph k=40 @0.25/40 vs default k=1: mismatch=${diff.fraction.toFixed(4)} considered=${diff.considered}`);
    expect(diff.considered).toBeGreaterThan(100); // the glyph drew ink (non-vacuous)
    expect(diff.fraction).toBe(0);
    fine.destroy();
    base.destroy();
  });

  it("the floored bake stays sub-pixel: only anti-aliasing differs from a true circle", async () => {
    // The cost of the floor, bounded: a 0.25px sagitta can move an edge pixel's coverage by at
    // most ~25%, i.e. ~64 of 255. So above that colour tolerance NOTHING may differ from a true
    // circle of the same pixel radius (a world disc at k = 1, baked 400× finer). A coarse control
    // (curveTolerance 2 → a 2px sagitta, which the floor keeps) proves the diff can see a facet.
    const truth = await mountPlot("canvas", 0.25 / 400, (chart) =>
      chart.layer("disc", [0], { draw: (ctx: PathContext) => fullCircle(ctx, W / 2, H / 2, GLYPH_R), fill: "rgb(0,0,0)", id: () => "d" }),
    );
    truth.chart.setTransform({ k: 1, x: 0, y: 0 });
    const fine = await glyphAt(0.25 / K, TRANSFORM);
    const coarse = await glyphAt(2, TRANSFORM);
    const opts = { radius: 0, colorTolerance: 80 };
    const fineDiff = diffPixels(canvasPixels(fine.host), canvasPixels(truth.host), opts);
    const coarseDiff = diffPixels(canvasPixels(coarse.host), canvasPixels(truth.host), opts);
    // eslint-disable-next-line no-console
    console.log(`[#283] vs true circle (Δ>80): floored=${fineDiff.fraction.toFixed(4)} coarse-control=${coarseDiff.fraction.toFixed(4)}`);
    expect(coarseDiff.fraction).toBeGreaterThan(0.05);
    expect(fineDiff.fraction).toBe(0);
    truth.destroy();
    fine.destroy();
    coarse.destroy();
  });
});

function canvasPixels(host: HTMLElement): PixelBuffer {
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("no canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: new Uint8Array(img.data.buffer.slice(0)) };
}
