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
import type { PathContext } from "../core/index.js";
import { plot } from "./plot.js";
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
