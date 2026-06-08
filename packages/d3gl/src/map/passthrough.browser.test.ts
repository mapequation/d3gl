import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import type { PassThroughLayer, PointBatch } from "../core/index.js";
import { CanvasBackend } from "../canvas/canvas-backend.js";
import { plot } from "./plot.js";
import { geoMap } from "./geo-map.js";
import { LayerHandle } from "./layer-handle.js";

// Task 5 pinned the public-API surface + the (then-true) "backend doesn't support pass-through"
// error. Task 6 adds REAL canvas pass-through rendering, so this file now asserts:
//   - the public-API surface (handles return synchronously; pass-through layers are NOT pickable),
//   - the canvas backend actually draws pass-through points on top of the retained base,
//   - handle.append() draws incrementally on top (first point stays, second appears),
//   - non-Point geometry under passThrough still throws on projection,
//   - snapshot-pan: a frozen raster blits under the delta transform during a gesture.
// (The canvas backend now declares supportsPassThrough, so the old "not supported" assertion is gone.)

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const point = (lon: number, lat: number): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [lon, lat] },
});
const polygon = (): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
});

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}
const canvasOf = (h: HTMLElement): HTMLCanvasElement => h.querySelector("canvas")!;
const at = (ctx: CanvasRenderingContext2D, x: number, y: number): Uint8ClampedArray => ctx.getImageData(x, y, 1, 1).data;

describe("passThrough public API", () => {
  it("plot.points(passThrough) returns a handle synchronously and creates no pickable retained layer", () => {
    const chart = plot(host(), { width: 200, height: 200, backend: "canvas" });
    // Called BEFORE whenReady(): no backend live yet, so registerPassThrough defers.
    const handle = chart.points(
      "pts",
      [{ x: 50, y: 50 }, { x: 100, y: 100 }],
      { x: (d) => d.x, y: (d) => d.y, radius: 4, fill: "rgb(255,0,0)", passThrough: true },
    );
    expect(handle).toBeInstanceOf(LayerHandle);
    expect(handle.name).toBe("pts");
    // No retained/pickable layer was created (pick reads specs + hit indexes only).
    expect(chart.pick(50, 50)).toBe(null);
    expect(chart.pick(100, 100)).toBe(null);
    // recolor() on a pass-through layer must not throw (it repaints; here it's a deferred no-op).
    expect(() => handle.recolor()).not.toThrow();
    chart.destroy();
  });

  it("geoMap.layer(passThrough) returns a handle synchronously and accepts a callback source", () => {
    const map = geoMap(host(), { width: 200, height: 200, projection: proj(), backend: "canvas" });
    const arrHandle = map.layer("cities", [point(0, 0), point(10, 10)], {
      fill: "rgb(0,0,255)", pointRadius: 4, passThrough: true,
    });
    expect(arrHandle).toBeInstanceOf(LayerHandle);
    expect(arrHandle.name).toBe("cities");

    const data = [point(0, 0)];
    const cbHandle = map.layer("dyn", () => data, { fill: "rgb(0,255,0)", passThrough: true });
    expect(cbHandle).toBeInstanceOf(LayerHandle);

    // No retained Point drawables → not pickable. (proj([0,0]) = [100,100].)
    expect(map.pick(100, 100)).toBe(null);
    map.destroy();
  });

  it("plot.points(callback) without passThrough throws", () => {
    const chart = plot(host(), { width: 200, height: 200, backend: "canvas" });
    expect(() =>
      chart.points("bad", () => [{ x: 0, y: 0 }], { x: (d) => d.x, y: (d) => d.y }),
    ).toThrow(/passThrough/);
    chart.destroy();
  });

  it("geoMap.layer(callback) without passThrough throws", () => {
    const map = geoMap(host(), { width: 200, height: 200, projection: proj(), backend: "canvas" });
    expect(() => map.layer("bad", () => [point(0, 0)], { fill: "red" })).toThrow(/passThrough/);
    map.destroy();
  });
});

describe("passThrough rendering (canvas backend)", () => {
  it("draws a pass-through point at its projected screen location", async () => {
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    // plot x/y are projected world coords; the initial transform is identity, so (60,60) → pixel (60,60).
    chart.points("pts", [{ x: 60, y: 60 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(255,0,0)", passThrough: true });
    const ctx = canvasOf(h).getContext("2d")!;
    const px = at(ctx, 60, 60);
    expect(px[0]!).toBeGreaterThan(180); // red where the point is
    expect(px[3]!).toBeGreaterThan(180); // opaque
    expect(at(ctx, 10, 10)[3]!).toBe(0); // nothing elsewhere
    chart.destroy();
  });

  it("handle.append() draws the new batch on top — first point remains, second appears", async () => {
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    const handle = chart.points("pts", [{ x: 50, y: 50 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(255,0,0)", passThrough: true });
    const ctx = canvasOf(h).getContext("2d")!;
    expect(at(ctx, 50, 50)[0]!).toBeGreaterThan(180); // first point drawn

    handle.append([{ x: 140, y: 140 }]); // incremental draw-on-top
    expect(at(ctx, 140, 140)[0]!).toBeGreaterThan(180); // second point appeared
    expect(at(ctx, 50, 50)[0]!).toBeGreaterThan(180);   // first point still there (no clear)
    chart.destroy();
  });

  it("pass-through points are NOT pickable", async () => {
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    chart.points("pts", [{ x: 60, y: 60 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    expect(chart.pick(60, 60)).toBe(null); // drawn, but no hit index → not pickable
    chart.destroy();
  });

  it("non-Point geometry under passThrough throws on projection", async () => {
    const map = geoMap(host(), { width: 200, height: 200, projection: proj(), backend: "canvas" });
    // Registration defers (no backend live yet); the backend install replays it, and the repaint
    // that projects the Polygon throws — surfacing via whenReady().
    map.layer("bad", [polygon()], { fill: "red", passThrough: true });
    await expect(map.whenReady()).rejects.toThrow(/passThrough supports only Point geometry in Phase 1/);
    map.destroy();
  });
});

describe("passThrough snapshot-pan (canvas backend, direct)", () => {
  // Driven at the backend level: deterministic and honest. The engine wiring
  // (setInteracting → snapshotPassThrough; setTransform during a gesture → render) is the
  // same call sequence exercised here. End-to-end gesture simulation is covered manually / Task 9.
  const layer: PassThroughLayer = { name: "pts" };
  const batchAt = (x: number, y: number, r: number): PointBatch => ({
    positions: new Float32Array([x, y]),
    radii: new Float32Array([r]),
    colors: new Uint8Array([255, 0, 0, 255]),
    count: 1,
  });

  it("blits the frozen raster under a pan delta, then a settle-repaint draws crisp again", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200; canvas.height = 200;
    const backend = new CanvasBackend(canvas, 200, 200);
    backend.setLayers([]); // no retained layers
    const ctx = canvas.getContext("2d")!;

    backend.setPassThroughLayer(layer);
    backend.drawPassThrough("pts", batchAt(50, 50, 6), "replace-first"); // identity transform
    expect(at(ctx, 50, 50)[0]!).toBeGreaterThan(180);

    // Gesture start: snapshot the canvas at the current (identity) transform.
    backend.snapshotPassThrough();
    // Pan by +40,+30: the engine calls setTransform then render(); render() must snapshot-pan.
    backend.setTransform({ k: 1, x: 40, y: 30 });
    backend.render();
    expect(at(ctx, 50, 50)[0]!).toBeLessThan(180);     // moved away from the old spot
    expect(at(ctx, 90, 80)[0]!).toBeGreaterThan(180);  // re-appears at +40,+30

    // Settle: engine repaints (replace-first) → snapshot cleared, crisp redraw at the new transform.
    backend.drawPassThrough("pts", batchAt(50, 50, 6), "replace-first");
    expect(at(ctx, 90, 80)[0]!).toBeGreaterThan(180);  // 50*1+40, 50*1+30
    backend.destroy();
  });

  it("scales the snapshot under a zoom delta", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200; canvas.height = 200;
    const backend = new CanvasBackend(canvas, 200, 200);
    backend.setLayers([]);
    const ctx = canvas.getContext("2d")!;

    backend.setPassThroughLayer(layer);
    backend.drawPassThrough("pts", batchAt(50, 50, 6), "replace-first"); // at pixel (50,50), identity
    backend.snapshotPassThrough();

    // Zoom 2x about the origin: world point (50,50) → screen (100,100).
    backend.setTransform({ k: 2, x: 0, y: 0 });
    backend.render();
    expect(at(ctx, 100, 100)[0]!).toBeGreaterThan(180); // snapshot scaled to the new location
    backend.destroy();
  });
});
