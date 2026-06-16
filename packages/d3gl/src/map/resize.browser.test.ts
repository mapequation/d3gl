import { describe, it, expect, vi } from "vitest";
import type { Polygon } from "geojson";
import { geoMercator } from "d3-geo";
import { plot } from "./plot.js";
import { geoMap } from "./geo-map.js";
import type { PathContext } from "../core/index.js";

const dpr = (): number => (typeof window !== "undefined" && window.devicePixelRatio) || 1;

function host(w?: number, h?: number): HTMLDivElement {
  const el = document.createElement("div");
  if (w != null) el.style.width = `${w}px`;
  if (h != null) el.style.height = `${h}px`;
  document.body.appendChild(el);
  return el;
}

/** Engine width from its SVG serialization (works for every backend). */
function engineWidth(svg: string): number {
  return Number(/width="(\d+)"/.exec(svg)?.[1] ?? 0);
}

/** A couple of small clockwise-wound cells, away from the antimeridian/poles. */
const cells: { id: string; geometry: Polygon }[] = [
  { id: "a", geometry: { type: "Polygon", coordinates: [[[-40, -20], [-40, 20], [0, 20], [0, -20], [-40, -20]]] } },
  { id: "b", geometry: { type: "Polygon", coordinates: [[[10, -10], [10, 30], [50, 30], [50, -10], [10, -10]]] } },
];

describe("in-place resize", () => {
  it("resizes a Plot's canvas surface and preserves world-space geometry", async () => {
    const el = host(100, 100);
    const chart = plot(el, { width: 100, height: 100, backend: "canvas" });
    await chart.whenReady();
    chart.layer("boxes", [{ x: 10, y: 10 }], {
      draw: (ctx: PathContext, d) => ctx.rect(d.x, d.y, 20, 20),
      fill: "rgb(255,0,0)",
      id: () => "box",
    });
    chart.render();
    expect(chart.pick(20, 20)?.id).toBe("box");

    chart.setSize(200, 200);
    const canvas = el.querySelector("canvas")!;
    expect(canvas.style.width).toBe("200px");
    expect(canvas.width).toBe(Math.round(200 * dpr())); // device-px backing store grew
    expect(engineWidth(chart.toSVG())).toBe(200);
    // World coords are size-independent (no view change), so the box stays put.
    expect(chart.pick(20, 20)?.id).toBe("box");

    // No-op when unchanged.
    expect(chart.setSize(200, 200)).toBe(chart);
    chart.destroy();
  });

  it("resizes a WebGL Plot without recreating the engine", async () => {
    const el = host(64, 64);
    const chart = plot(el, { width: 64, height: 64, backend: "webgl" });
    await chart.whenReady();
    chart.layer("boxes", [{ x: 8, y: 8 }], {
      draw: (ctx: PathContext, d) => ctx.rect(d.x, d.y, 16, 16),
      fill: "rgb(0,128,255)",
      id: () => "box",
    });
    chart.render();
    chart.setSize(128, 96);
    const canvas = el.querySelector("canvas")!;
    expect(canvas.style.width).toBe("128px");
    expect(chart.toPNG().startsWith("data:image/png")).toBe(true); // offscreen FBO resized OK
    expect(chart.pick(16, 16)?.id).toBe("box");
    chart.destroy();
  });

  it("refits a GeoMap projection on a uniform resize (scale ∝ size)", async () => {
    const el = host(100, 100);
    const projection = geoMercator();
    projection.fitSize([100, 100], { type: "Sphere" });
    const s0 = projection.scale();
    const t0 = projection.translate();
    const map = geoMap(el, { width: 100, height: 100, projection, backend: "canvas" });
    map.layer("cells", cells, { fill: "rgb(20,160,90)" });
    await map.whenReady();

    map.setSize(200, 200); // uniform 2× → exact proportional rescale
    expect(projection.scale()).toBeCloseTo(s0 * 2, 2);
    expect(projection.translate()[0]).toBeCloseTo(t0[0] * 2, 2);
    expect(projection.translate()[1]).toBeCloseTo(t0[1] * 2, 2);
    map.destroy();
  });

  it("re-letterboxes a GeoMap when the aspect ratio changes (fill mode)", async () => {
    const el = host(100, 100);
    const projection = geoMercator();
    projection.fitSize([100, 100], { type: "Sphere" });
    const s0 = projection.scale();
    const map = geoMap(el, { width: 100, height: 100, projection, backend: "canvas" });
    map.layer("cells", cells, { fill: "rgb(20,160,90)" });
    await map.whenReady();

    map.setSize(300, 100); // wider box → refit via fitSize against retained geometry
    const s = projection.scale();
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
    expect(s).not.toBeCloseTo(s0, 2); // reflowed, not just preserved
    map.destroy();
  });

  it("tracks the host box in responsive fill mode via ResizeObserver", async () => {
    const el = host(120, 80); // sized by CSS, no width/height props
    const chart = plot(el, { backend: "canvas" });
    await chart.whenReady();
    expect(engineWidth(chart.toSVG())).toBe(120); // measured at construction

    el.style.width = "240px";
    await vi.waitFor(() => expect(engineWidth(chart.toSVG())).toBe(240), { timeout: 2000 });
    chart.destroy();
  });
});
