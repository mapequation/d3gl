import { describe, it, expect, afterEach } from "vitest";
import { geoEquirectangular } from "d3-geo";
import type { PassThroughLayer, DrawBatch } from "../core/index.js";
import { CanvasBackend } from "../canvas/canvas-backend.js";
import { BaseEngine } from "./base-engine.js";
import { plot, Plot } from "./plot.js";
import type { PlotOptions } from "./plot.js";
import { geoMap, GeoMap } from "./geo-map.js";
import { LayerHandle } from "./layer-handle.js";
import { createCanvasBackend, type BackendHandle } from "./backend-factory.js";
import type { ViewTransform } from "../core/index.js";
import type { WebGLBackend } from "../webgl/webgl-backend.js";

// Task 5 pinned the public-API surface + the (then-true) "backend doesn't support pass-through"
// error. Task 6 adds REAL canvas pass-through rendering, so this file now asserts:
//   - the public-API surface (handles return synchronously; pass-through layers are NOT pickable),
//   - the canvas backend actually draws pass-through points on top of the retained base,
//   - handle.append() draws incrementally on top (first point stays, second appears),
//   - non-Point geometry under passThrough no longer throws (Phase 3 lifted the Point-only guard),
//     and the canvas backend fills polygons + strokes lines (a separate geometry suite),
//   - snapshot-pan: a frozen raster blits under the delta transform during a gesture.
// (The canvas backend now declares supportsPassThrough, so the old "not supported" assertion is gone.)
//
// Phase 2: WebGL now implements the pass-through contract too. The suites at the bottom assert,
// against a REAL WebGL device (this browser has WebGL):
//   - the "auto" backend upgrades canvas → WebGL with pass-through layers present, and the
//     pass-through point survives the upgrade (read back from the now-WebGL-backed canvas),
//   - explicit backend:"webgl" renders a pass-through point, accumulates an append, carries
//     per-point colors, and snapshot-pans during a gesture then settles crisp.

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

/** Await `n` real animation frames (the browser env has a real rAF) so time-sliced
 *  repaints can advance their scheduled slices. */
const frames = (n: number): Promise<void> =>
  new Promise((resolve) => {
    let left = n;
    const tick = (): void => { if (--left <= 0) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

describe("passThrough SVG backend rejection", () => {
  it("SVG backend throws when passThrough: true is registered after backend is ready", async () => {
    const chart = plot(host(), { width: 200, height: 200, backend: "svg" });
    await chart.whenReady();
    expect(() =>
      chart.points("pts", [{ x: 1, y: 1 }], { x: (d) => d.x, y: (d) => d.y, passThrough: true }),
    ).toThrow(/passThrough/);
    chart.destroy();
  });
});

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

  it("non-Point geometry under passThrough no longer throws (Phase 3 lifts the guard)", async () => {
    const map = geoMap(host(), { width: 200, height: 200, projection: proj(), backend: "canvas" });
    // Registration defers (no backend live yet); the backend install replays it and the repaint
    // projects + records the Polygon. The Phase-1 Point-only throw is gone.
    map.layer("poly", [polygon()], { fill: "red", passThrough: true });
    await expect(map.whenReady()).resolves.toBeUndefined();
    map.destroy();
  });
});

describe("passThrough geometry rendering (canvas backend)", () => {
  // geo-map is where GeoJSON geometry lives; the equirectangular proj() maps [lon,lat] to
  // pixels as x = 100 + lon, y = 100 - lat (scale 50 → 1°≈0.87px; here we keep it simple by
  // computing through the projection). We assert real getImageData pixels on the canvas backend.
  const project = (lon: number, lat: number): [number, number] => {
    const p = proj()([lon, lat])!;
    return [p[0], p[1]];
  };
  // A big CLOCKWISE-wound polygon (clockwise in [lon,lat] fills its interior; CCW fills the
  // whole map — see AGENTS.md winding note). Spans lon 0..20, lat 0..20.
  const bigPolygon = (): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[0, 20], [20, 20], [20, 0], [0, 0], [0, 20]]] },
  });
  const polygon2 = (): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[-30, -5], [-10, -5], [-10, -25], [-30, -25], [-30, -5]]] },
  });
  // A line along the equator: the geodesic between two equatorial points IS the equator,
  // so it projects to a straight horizontal line (no great-circle bow to chase in pixels).
  const line = (): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: [[-40, 0], [40, 0]] },
  });

  it("renders a filled Polygon: inside reads the fill color, outside is background", async () => {
    const h = host();
    const map = geoMap(h, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    map.layer("poly", [bigPolygon()], { fill: "rgb(0,200,0)", passThrough: true });
    await map.whenReady();
    const ctx = canvasOf(h).getContext("2d")!;
    // Centroid at lon 10, lat 10.
    const [cx, cy] = project(10, 10);
    const inside = at(ctx, Math.round(cx), Math.round(cy));
    expect(inside[1]!).toBeGreaterThan(150); // green fill inside
    expect(inside[3]!).toBeGreaterThan(180); // opaque
    // Well outside the polygon (lon -50, lat -40 → far corner).
    const [ox, oy] = project(-50, -40);
    expect(at(ctx, Math.round(ox), Math.round(oy))[3]!).toBe(0);
    map.destroy();
  });

  it("renders a LineString stroke: a pixel on the line reads the stroke color", async () => {
    const h = host();
    const map = geoMap(h, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    map.layer("line", [line()], { stroke: "rgb(0,0,255)", lineWidth: 4, passThrough: true });
    await map.whenReady();
    const ctx = canvasOf(h).getContext("2d")!;
    // Midpoint of the line at lon 0, lat 0 (the equator → no projected bow).
    const [mx, my] = project(0, 0);
    const px = at(ctx, Math.round(mx), Math.round(my));
    expect(px[2]!).toBeGreaterThan(150); // blue stroke
    expect(px[3]!).toBeGreaterThan(120); // present
    map.destroy();
  });

  it("handle.append() adds another polygon incrementally (first remains)", async () => {
    const h = host();
    const map = geoMap(h, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    const handle = map.layer("poly", [bigPolygon()], { fill: "rgb(0,200,0)", passThrough: true });
    await map.whenReady();
    const ctx = canvasOf(h).getContext("2d")!;
    const [c1x, c1y] = project(10, 10);
    expect(at(ctx, Math.round(c1x), Math.round(c1y))[1]!).toBeGreaterThan(150); // first polygon

    handle.append([polygon2()]); // incremental draw-on-top
    const [c2x, c2y] = project(-20, -15); // centroid of polygon2
    expect(at(ctx, Math.round(c2x), Math.round(c2y))[1]!).toBeGreaterThan(150); // second appeared
    expect(at(ctx, Math.round(c1x), Math.round(c1y))[1]!).toBeGreaterThan(150); // first still there
    map.destroy();
  });

  it("a geometry pass-through layer is NOT pickable", async () => {
    const h = host();
    const map = geoMap(h, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    map.layer("poly", [bigPolygon()], { fill: "rgb(0,200,0)", passThrough: true });
    await map.whenReady();
    const [cx, cy] = project(10, 10);
    expect(map.pick(Math.round(cx), Math.round(cy))).toBe(null); // drawn, but no hit index
    map.destroy();
  });
});

describe("passThrough time-sliced repaint", () => {
  // PT_CHUNK is a protected static (no public API for it). Tests stub it via an `any` cast so
  // a modest dataset (not the real 500k) exercises multi-chunk slicing fast. We restore it
  // after each test so other suites see the production value.
  const realChunk = (BaseEngine as any).PT_CHUNK as number;
  afterEach(() => { (BaseEngine as any).PT_CHUNK = realChunk; });

  it("renders the first chunk synchronously, later chunks across rAF frames", async () => {
    (BaseEngine as any).PT_CHUNK = 2; // 2 points/slice → 3 points spans two slices
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    // Three points at distinct pixels (identity transform). Chunk 0 = pts[0..1], chunk 1 = pts[2].
    chart.points(
      "pts",
      [{ x: 30, y: 30 }, { x: 60, y: 60 }, { x: 120, y: 120 }],
      { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(255,0,0)", passThrough: true },
    );
    const ctx = canvasOf(h).getContext("2d")!;
    // First chunk painted synchronously by the initial step() (no awaited frame yet).
    expect(at(ctx, 30, 30)[0]!).toBeGreaterThan(180);
    expect(at(ctx, 60, 60)[0]!).toBeGreaterThan(180);
    // The third point is in a later chunk scheduled on rAF — not drawn yet.
    expect(at(ctx, 120, 120)[3]!).toBe(0);

    await frames(3); // let the scheduled slice run
    expect(at(ctx, 120, 120)[0]!).toBeGreaterThan(180); // later chunk now painted
    // Earlier chunks survive (later slices use "replace-rest" = draw-on-top, no clear).
    expect(at(ctx, 30, 30)[0]!).toBeGreaterThan(180);
    chart.destroy();
  });

  it("an interaction mid-fill cancels the in-flight repaint (no further chunks paint)", async () => {
    (BaseEngine as any).PT_CHUNK = 1; // 1 point/slice → each point needs its own frame
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    chart.enableZoom(); // so setInteracting(true) snapshots + cancels
    chart.points(
      "pts",
      [{ x: 30, y: 30 }, { x: 80, y: 80 }, { x: 140, y: 140 }],
      { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(255,0,0)", passThrough: true },
    );
    const ctx = canvasOf(h).getContext("2d")!;
    // Only the first chunk drew synchronously; chunks 2 and 3 are pending on rAF.
    expect(at(ctx, 30, 30)[0]!).toBeGreaterThan(180);
    expect(at(ctx, 80, 80)[3]!).toBe(0);

    // Start a gesture: bumps the layer's token, cancelling the pending slices.
    // (Plot extends BaseEngine; setInteracting is protected, reached via an `any` cast.)
    (chart as any).setInteracting(true);

    await frames(5); // the stale step() must no-op; no further chunks paint
    expect(at(ctx, 80, 80)[3]!).toBe(0);
    expect(at(ctx, 140, 140)[3]!).toBe(0);
    chart.destroy();
  });
});

describe("passThrough retained-layer coexistence (Part C)", () => {
  it("re-pushing a retained layer keeps pass-through points visible (they get repainted)", async () => {
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    // A pass-through point at (60,60).
    chart.points("pts", [{ x: 60, y: 60 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(255,0,0)", passThrough: true });
    const ctx = canvasOf(h).getContext("2d")!;
    expect(at(ctx, 60, 60)[0]!).toBeGreaterThan(180);

    // Register a RETAINED layer somewhere else. registerLayer → pushLayers → backend.render()
    // clears the canvas (and the pass-through pixels). Part C must repaint the PT layer after.
    chart.points("base", [{ x: 150, y: 150 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(0,0,255)" });

    // Retained base drew; the pass-through point survived the clear (repainted on top of render()).
    expect(at(ctx, 150, 150)[2]!).toBeGreaterThan(180); // blue retained point
    expect(at(ctx, 60, 60)[0]!).toBeGreaterThan(180);   // red pass-through point still visible
    chart.destroy();
  });
});

describe("passThrough snapshot-pan (canvas backend, direct)", () => {
  // Driven at the backend level: deterministic and honest. The engine wiring
  // (setInteracting → snapshotPassThrough; setTransform during a gesture → render) is the
  // same call sequence exercised here. End-to-end gesture simulation is covered manually / Task 9.
  const layer: PassThroughLayer = { name: "pts" };
  const batchAt = (x: number, y: number, r: number): DrawBatch => ({
    points: {
      positions: new Float32Array([x, y]),
      radii: new Float32Array([r]),
      colors: new Uint8Array([255, 0, 0, 255]),
      count: 1,
    },
    paths: null,
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

describe('passThrough "auto" backend upgrade guard (unsupported upgrade target)', () => {
  // The "auto" backend starts on Canvas then upgrades to WebGL in the background. The real WebGL
  // backend now supports pass-through (Phase 2+), so a real upgrade carries the layers over — see
  // the "real upgrade to WebGL" test above. This block instead covers the DEFENSIVE guard for an
  // upgrade target that LACKS pass-through support: without it, the upgrade would destroy the canvas
  // (losing the PT raster) and THROW at installBackend's unsupported-backend check (an unhandled
  // rejection, plus the points vanish). The fix aborts the upgrade and stays on canvas.
  //
  // We drive this deterministically by stubbing createWebGLBackend (the protected test seam) to
  // return a backend whose supportsPassThrough is forced falsy — UNLIKE the real WebGL backend,
  // purely to exercise the guard without depending on a hypothetical unsupported backend. The
  // subclass exposes the private upgradeDone promise so the test can await the upgrade window.
  class StubPlot extends Plot {
    stubbedWebGL: BackendHandle | null = null;
    constructor(host: HTMLElement, opts: PlotOptions) { super(host, opts); }
    protected createWebGLBackend(): Promise<BackendHandle> {
      // A canvas-backed handle is a fully-working backend, but we force supportsPassThrough
      // FALSY to exercise the defensive abort guard. The REAL WebGLBackend now sets
      // supportsPassThrough = true (so a real auto-upgrade PROCEEDS — see the real test below);
      // the stub forces it falsy ONLY to drive the graceful-abort path without a GPU device.
      const h = createCanvasBackend(this.host, this.width, this.height);
      (h.backend as { supportsPassThrough?: boolean }).supportsPassThrough = false;
      this.stubbedWebGL = h;
      return Promise.resolve(h);
    }
    awaitUpgrade(): Promise<void> {
      return (this as unknown as { upgradeDone: Promise<void> | null }).upgradeDone ?? Promise.resolve();
    }
    liveBackendType(): string {
      return (this as unknown as { backendType(): string }).backendType();
    }
  }

  it("auto-upgrade with a pass-through layer stays on canvas (no throw, points survive)", async () => {
    const h = host();
    const chart = new StubPlot(h, { width: 200, height: 200, backend: "auto" });
    // Register the pass-through layer on the synchronous canvas first paint, BEFORE the
    // background upgrade settles — this is the reachable scenario the bug is about. (auto's
    // whenReady() resolves at the canvas paint; the WebGL upgrade is a separate in-flight promise.)
    chart.points("pts", [{ x: 60, y: 60 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(255,0,0)", passThrough: true });
    await chart.whenReady(); // canvas first paint
    const ctx = canvasOf(h).getContext("2d")!;
    expect(at(ctx, 60, 60)[0]!).toBeGreaterThan(180); // visible before the upgrade fires

    // Drive the background WebGL upgrade to completion. The guard must abort it gracefully.
    await expect(chart.awaitUpgrade()).resolves.toBeUndefined(); // no throw / unhandled rejection

    // (a) stayed on canvas, (b) the WebGL handle was torn down (not installed),
    expect(chart.liveBackendType()).toBe("canvas");
    expect(canvasOf(h)).toBe(ctx.canvas); // same live canvas — never swapped out
    // (c) the pass-through point is still visible after the upgrade window.
    expect(at(ctx, 60, 60)[0]!).toBeGreaterThan(180);
    expect(at(ctx, 60, 60)[3]!).toBeGreaterThan(180);
    chart.destroy();
  });

  it("auto-upgrade WITHOUT pass-through layers still upgrades to WebGL", async () => {
    const h = host();
    const chart = new StubPlot(h, { width: 200, height: 200, backend: "auto" });
    await chart.whenReady();
    // A retained (non-pass-through) layer — no PT, so the upgrade must proceed normally.
    chart.points("base", [{ x: 50, y: 50 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(0,0,255)" });

    await expect(chart.awaitUpgrade()).resolves.toBeUndefined();
    expect(chart.liveBackendType()).toBe("webgl"); // upgrade committed
    chart.destroy();
  });

  it('explicit setBackend with an unsupported backend still throws (only the silent auto-upgrade stays on canvas)', async () => {
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    chart.points("pts", [{ x: 60, y: 60 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(255,0,0)", passThrough: true });
    // SVG declares supportsPassThrough = false; an explicit swap surfaces via whenReady().
    chart.setBackend("svg");
    await expect(chart.whenReady()).rejects.toThrow(/passThrough is not supported.*canvas or webgl backend/);
    chart.destroy();
  });
});

/**
 * A REAL-WebGL Plot subclass (no stub of createWebGLBackend — the test browser has WebGL).
 * It exposes the same minimal, test-only seams as StubPlot above:
 *   - awaitUpgrade(): the private upgradeDone promise, so the test can await the background
 *     "auto" → WebGL upgrade precisely (whenReady() for "auto" resolves at the canvas paint,
 *     while the upgrade is still in flight);
 *   - liveBackendType(): the protected backendType();
 *   - screenPixel(): reads a pixel from the live WebGL backend's onscreen canvas via the
 *     backend's readScreenPixel() test aid (the WebGL canvas has a webgl2 context, not "2d",
 *     so getImageData() is unavailable — we read real GPU pixels off the default framebuffer);
 *   - interact()/applyTransform(): drive the engine's protected setInteracting()/setTransform()
 *     — the exact calls d3-zoom's start/zoom/end handlers make — so snapshot-pan is exercised
 *     end-to-end through the engine without synthesizing real pointer events.
 * No public API is added; these mirror StubPlot's existing seam pattern.
 */
class GLPlot extends Plot {
  awaitUpgrade(): Promise<void> {
    return (this as unknown as { upgradeDone: Promise<void> | null }).upgradeDone ?? Promise.resolve();
  }
  liveBackendType(): string {
    return (this as unknown as { backendType(): string }).backendType();
  }
  private gl(): WebGLBackend {
    return (this as unknown as { backend(): WebGLBackend | null }).backend()!;
  }
  screenPixel(x: number, y: number): number[] {
    return this.gl().readScreenPixel(x, y);
  }
  interact(v: boolean): void {
    (this as unknown as { setInteracting(v: boolean): void }).setInteracting(v);
  }
  applyTransform(t: ViewTransform): void {
    (this as unknown as { setTransform(t: ViewTransform): this }).setTransform(t);
  }
}

describe('passThrough "auto" backend real upgrade to WebGL (Phase 2: WebGL has PT)', () => {
  it("auto-upgrades canvas → WebGL with a pass-through layer present; the point survives the upgrade", async () => {
    const h = host();
    const chart = new GLPlot(h, { width: 200, height: 200, backend: "auto" });
    // Register a pass-through point on the synchronous canvas first paint, BEFORE the
    // background upgrade settles. WebGL now supports pass-through, so the upgrade PROCEEDS:
    // installBackend re-registers + repaints the PT layer onto the WebGL backend.
    chart.points("pts", [{ x: 60, y: 60 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    await chart.whenReady(); // canvas first paint (upgrade still in flight)

    // Drive the REAL background WebGL upgrade to completion (no stub).
    await expect(chart.awaitUpgrade()).resolves.toBeUndefined();

    // (a) the live backend committed to WebGL.
    expect(chart.liveBackendType()).toBe("webgl");
    // (b) the pass-through point is still rendered, read back as real GPU pixels from the
    //     now-WebGL-backed canvas (the canvas element was swapped during the upgrade).
    const px = chart.screenPixel(60, 60);
    expect(px[0]!).toBeGreaterThan(180); // red where the point is
    expect(px[3]!).toBeGreaterThan(180); // opaque
    const away = chart.screenPixel(10, 10);
    expect(away[3]!).toBeLessThan(40);   // nothing elsewhere
    chart.destroy();
  });
});

/**
 * A real-WebGL GeoMap exposing the same screenPixel() seam as GLPlot, so geo polygon/line
 * pass-through can be asserted against real GPU pixels read off the WebGL canvas.
 */
class GLGeoMap extends GeoMap {
  private gl(): WebGLBackend {
    return (this as unknown as { backend(): WebGLBackend | null }).backend()!;
  }
  liveBackendType(): string {
    return (this as unknown as { backendType(): string }).backendType();
  }
  screenPixel(x: number, y: number): number[] {
    return this.gl().readScreenPixel(x, y);
  }
  // Same seam as GLPlot.awaitUpgrade(): "auto" whenReady() resolves at the canvas paint while
  // the background canvas → WebGL upgrade is still in flight; this awaits that upgrade precisely.
  awaitUpgrade(): Promise<void> {
    return (this as unknown as { upgradeDone: Promise<void> | null }).upgradeDone ?? Promise.resolve();
  }
}

describe("passThrough geometry rendering (webgl backend)", () => {
  // Mirrors the canvas Task-3 geometry suite but on a real WebGL device: polygons fill and
  // lines stroke into the accumulation FBO (world mode), read back as real GPU pixels.
  const project = (lon: number, lat: number): [number, number] => {
    const p = proj()([lon, lat])!;
    return [p[0], p[1]];
  };
  const bigPolygon = (): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[0, 20], [20, 20], [20, 0], [0, 0], [0, 20]]] },
  });
  const polygon2 = (): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[-30, -5], [-10, -5], [-10, -25], [-30, -25], [-30, -5]]] },
  });
  const line = (): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: [[-40, 0], [40, 0]] },
  });

  it("rasterizes a filled Polygon: inside reads the fill color", async () => {
    const map = new GLGeoMap(host(), { width: 200, height: 200, projection: proj(), backend: "webgl" });
    map.layer("poly", [bigPolygon()], { fill: "rgb(0,200,0)", passThrough: true });
    await map.whenReady();
    expect(map.liveBackendType()).toBe("webgl");
    const [cx, cy] = project(10, 10); // centroid
    const inside = map.screenPixel(Math.round(cx), Math.round(cy));
    expect(inside[1]!).toBeGreaterThan(150); // green fill inside
    expect(inside[3]!).toBeGreaterThan(180); // opaque
    const [ox, oy] = project(-50, -40);
    expect(map.screenPixel(Math.round(ox), Math.round(oy))[3]!).toBeLessThan(40); // empty outside
    map.destroy();
  });

  it("rasterizes a LineString stroke: a pixel on the line reads the stroke color", async () => {
    const map = new GLGeoMap(host(), { width: 200, height: 200, projection: proj(), backend: "webgl" });
    map.layer("line", [line()], { stroke: "rgb(0,0,255)", lineWidth: 4, passThrough: true });
    await map.whenReady();
    const [mx, my] = project(0, 0); // midpoint on the equator
    const px = map.screenPixel(Math.round(mx), Math.round(my));
    expect(px[2]!).toBeGreaterThan(150); // blue stroke
    expect(px[3]!).toBeGreaterThan(120); // present
    map.destroy();
  });

  it("handle.append() adds another polygon incrementally (first remains)", async () => {
    const map = new GLGeoMap(host(), { width: 200, height: 200, projection: proj(), backend: "webgl" });
    const handle = map.layer("poly", [bigPolygon()], { fill: "rgb(0,200,0)", passThrough: true });
    await map.whenReady();
    const [c1x, c1y] = project(10, 10);
    expect(map.screenPixel(Math.round(c1x), Math.round(c1y))[1]!).toBeGreaterThan(150); // first

    handle.append([polygon2()]); // incremental draw-on-top (FBO accumulation)
    const [c2x, c2y] = project(-20, -15); // centroid of polygon2
    expect(map.screenPixel(Math.round(c2x), Math.round(c2y))[1]!).toBeGreaterThan(150); // second appeared
    expect(map.screenPixel(Math.round(c1x), Math.round(c1y))[1]!).toBeGreaterThan(150); // first still there
    map.destroy();
  });
});

describe("passThrough rendering (webgl backend)", () => {
  it("draws a pass-through point at its projected screen location", async () => {
    const h = host();
    const chart = new GLPlot(h, { width: 200, height: 200, backend: "webgl" });
    await chart.whenReady();
    chart.points("pts", [{ x: 60, y: 60 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    const px = chart.screenPixel(60, 60);
    expect(px[0]!).toBeGreaterThan(180); // red point present
    expect(px[3]!).toBeGreaterThan(180); // opaque
    expect(chart.screenPixel(10, 10)[3]!).toBeLessThan(40); // nothing elsewhere
    chart.destroy();
  });

  it("handle.append() accumulates a second point (FBO accumulation) while the first remains", async () => {
    const h = host();
    const chart = new GLPlot(h, { width: 200, height: 200, backend: "webgl" });
    await chart.whenReady();
    const handle = chart.points("pts", [{ x: 50, y: 50 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    expect(chart.screenPixel(50, 50)[0]!).toBeGreaterThan(180); // first point drawn

    handle.append([{ x: 140, y: 140 }]); // "append" mode → composited on top of the FBO
    expect(chart.screenPixel(140, 140)[0]!).toBeGreaterThan(180); // second point appeared
    expect(chart.screenPixel(50, 50)[0]!).toBeGreaterThan(180);   // first point still accumulated
    chart.destroy();
  });

  it("renders per-point fill colors end-to-end (per-point color attribute)", async () => {
    const h = host();
    const chart = new GLPlot(h, { width: 200, height: 200, backend: "webgl" });
    await chart.whenReady();
    // Two points, distinct fills resolved per-datum. The packed RGBA per-vertex attribute must
    // carry each point's own color through projectPoints → PassThroughGL → composite.
    chart.points(
      "pts",
      [{ x: 50, y: 50, c: "rgb(255,0,0)" }, { x: 140, y: 140, c: "rgb(0,0,255)" }],
      { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: (d) => d.c, passThrough: true },
    );
    const red = chart.screenPixel(50, 50);
    const blue = chart.screenPixel(140, 140);
    expect(red[0]!).toBeGreaterThan(180); expect(red[2]!).toBeLessThan(60);  // first is red
    expect(blue[2]!).toBeGreaterThan(180); expect(blue[0]!).toBeLessThan(60); // second is blue
    chart.destroy();
  });

  it("snapshot-pan: the FBO blits to the panned location during a gesture, then settles crisp", async () => {
    const h = host();
    const chart = new GLPlot(h, { width: 200, height: 200, backend: "webgl" });
    await chart.whenReady();
    chart.points("pts", [{ x: 50, y: 50 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    expect(chart.screenPixel(50, 50)[0]!).toBeGreaterThan(180); // crisp at the origin

    // Gesture start (d3-zoom "start" → setInteracting(true)): snapshot reference captured.
    chart.interact(true);
    // Pan by +40,+30 (d3-zoom "zoom" → setTransform): while interacting the backend blits the
    // FBO under the delta instead of re-rasterizing, so the point appears at the panned spot.
    chart.applyTransform({ k: 1, x: 40, y: 30 });
    expect(chart.screenPixel(50, 50)[0]!).toBeLessThan(120);    // moved away from the old spot
    expect(chart.screenPixel(90, 80)[0]!).toBeGreaterThan(180); // re-appears at +40,+30

    // Settle (d3-zoom "end" → setInteracting(false)): crisp re-rasterize at the new transform.
    chart.interact(false);
    expect(chart.screenPixel(90, 80)[0]!).toBeGreaterThan(180); // still at the panned location
    // After settle the old pre-pan pixel must be cleared (re-rasterize replaces; not composited on top).
    expect(chart.screenPixel(50, 50)[0]!).toBeLessThan(60);     // original location cleared
    chart.destroy();
  });
});

// ── Phase 3 INTEGRATION ──────────────────────────────────────────────────────
// End-to-end proof of the UNIFIED pipeline: one pass-through layer carrying MIXED
// GeoJSON geometry (Point + Polygon + LineString) flows through one buildBatch →
// DrawBatch{points, paths} → drawPassThrough on BOTH backends, and the "auto"
// upgrade keeps polygon/line pass-through (the points-only WebGL gap that existed
// mid-phase is closed). Real pixels, no mocks.
//
// Shared mixed FeatureCollection: three distinct-colour geometries at well-separated
// projected locations so each kind can be probed independently.
//   - filled Polygon  (green) spanning lon 0..20, lat 0..20 → centroid (10,10)
//   - LineString      (blue)  along the equator lon -40..40, lat 0 → midpoint (0,0)
//   - Point           (red)   at lon -30, lat 30 (top-left quadrant, clear of both)
// The polygon is CLOCKWISE-wound in [lon,lat] (CCW fills the whole map — AGENTS.md).
const mixedProject = (lon: number, lat: number): [number, number] => {
  const p = proj()([lon, lat])!;
  return [p[0], p[1]];
};
const mixedPolygon = (): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[[0, 20], [20, 20], [20, 0], [0, 0], [0, 20]]] },
});
const mixedLine = (): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [[-40, 0], [40, 0]] },
});
const mixedPoint = (): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [-30, 30] },
});
// Per-feature colours resolved by the accessors below (geo layer style accessors
// receive the feature, so one layer can carry three kinds in three colours).
const mixedFill = (f: GeoJSON.Feature): string =>
  f.geometry.type === "Polygon" ? "rgb(0,200,0)" : "rgb(255,0,0)"; // polygon green, point red
const mixedStroke = (): string => "rgb(0,0,255)"; // line blue

describe("passThrough mixed-geometry integration (both backends)", () => {
  it("canvas: one pass-through layer renders Point + Polygon + LineString at their projected spots", async () => {
    const h = host();
    const map = geoMap(h, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    map.layer("mixed", [mixedPolygon(), mixedLine(), mixedPoint()], {
      fill: mixedFill,
      stroke: mixedStroke,
      lineWidth: 4,
      pointRadius: 6,
      passThrough: true,
    });
    await map.whenReady();
    const ctx = canvasOf(h).getContext("2d")!;

    // Polygon: centroid reads green fill.
    const [px, py] = mixedProject(10, 10);
    const poly = at(ctx, Math.round(px), Math.round(py));
    expect(poly[1]!).toBeGreaterThan(150); // green
    expect(poly[3]!).toBeGreaterThan(180); // opaque

    // Line: equator midpoint reads blue stroke.
    const [lx, ly] = mixedProject(0, 0);
    const ln = at(ctx, Math.round(lx), Math.round(ly));
    expect(ln[2]!).toBeGreaterThan(150); // blue
    expect(ln[3]!).toBeGreaterThan(120); // present

    // Point: its projected location reads red.
    const [ptx, pty] = mixedProject(-30, 30);
    const pt = at(ctx, Math.round(ptx), Math.round(pty));
    expect(pt[0]!).toBeGreaterThan(180); // red
    expect(pt[3]!).toBeGreaterThan(180); // opaque

    // Background well clear of all three is empty.
    const [ox, oy] = mixedProject(-50, -40);
    expect(at(ctx, Math.round(ox), Math.round(oy))[3]!).toBe(0);
    map.destroy();
  });

  it("webgl: one pass-through layer renders Point + Polygon + LineString at their projected spots", async () => {
    const map = new GLGeoMap(host(), { width: 200, height: 200, projection: proj(), backend: "webgl" });
    map.layer("mixed", [mixedPolygon(), mixedLine(), mixedPoint()], {
      fill: mixedFill,
      stroke: mixedStroke,
      lineWidth: 4,
      pointRadius: 6,
      passThrough: true,
    });
    await map.whenReady();
    expect(map.liveBackendType()).toBe("webgl");

    // Polygon: centroid reads green fill (tessellated into the accumulation FBO).
    const [px, py] = mixedProject(10, 10);
    const poly = map.screenPixel(Math.round(px), Math.round(py));
    expect(poly[1]!).toBeGreaterThan(150); // green
    expect(poly[3]!).toBeGreaterThan(180); // opaque

    // Line: equator midpoint reads blue stroke.
    const [lx, ly] = mixedProject(0, 0);
    const ln = map.screenPixel(Math.round(lx), Math.round(ly));
    expect(ln[2]!).toBeGreaterThan(150); // blue
    expect(ln[3]!).toBeGreaterThan(120); // present

    // Point: its projected location reads red (rasterized into the same FBO).
    const [ptx, pty] = mixedProject(-30, 30);
    const pt = map.screenPixel(Math.round(ptx), Math.round(pty));
    expect(pt[0]!).toBeGreaterThan(180); // red
    expect(pt[3]!).toBeGreaterThan(180); // opaque

    // Background well clear of all three is empty.
    const [ox, oy] = mixedProject(-50, -40);
    expect(map.screenPixel(Math.round(ox), Math.round(oy))[3]!).toBeLessThan(40);
    map.destroy();
  });
});

describe('passThrough "auto" upgrade keeps polygon/line pass-through (regression)', () => {
  // The mid-phase WebGL gap: auto upgraded canvas→WebGL but the WebGL backend only
  // handled pass-through POINTS, so polygons/lines vanished on upgrade. Phase 3 routes
  // all geometry through one buildBatch/DrawBatch pipeline; the upgrade re-registers +
  // repaints the FULL batch (points AND paths) onto WebGL. This is the regression guard.
  it("auto: a pass-through Polygon (+ line, + point) survives the real canvas → WebGL upgrade", async () => {
    const map = new GLGeoMap(host(), { width: 200, height: 200, projection: proj(), backend: "auto" });
    // Registered on the synchronous canvas first paint, BEFORE the background upgrade settles.
    map.layer("mixed", [mixedPolygon(), mixedLine(), mixedPoint()], {
      fill: mixedFill,
      stroke: mixedStroke,
      lineWidth: 4,
      pointRadius: 6,
      passThrough: true,
    });
    await map.whenReady(); // canvas first paint (upgrade still in flight)

    // Drive the REAL background WebGL upgrade to completion.
    await expect(map.awaitUpgrade()).resolves.toBeUndefined();

    // (a) the live backend committed to WebGL.
    expect(map.liveBackendType()).toBe("webgl");

    // (b) the Polygon is STILL rendered after the upgrade (the closed gap), read back as
    //     real GPU pixels off the now-WebGL-backed canvas.
    const [px, py] = mixedProject(10, 10);
    const poly = map.screenPixel(Math.round(px), Math.round(py));
    expect(poly[1]!).toBeGreaterThan(150); // green polygon fill survived
    expect(poly[3]!).toBeGreaterThan(180); // opaque

    // The line and point survived too (full mixed batch re-rendered, not points-only).
    const [lx, ly] = mixedProject(0, 0);
    expect(map.screenPixel(Math.round(lx), Math.round(ly))[2]!).toBeGreaterThan(150); // blue line
    const [ptx, pty] = mixedProject(-30, 30);
    expect(map.screenPixel(Math.round(ptx), Math.round(pty))[0]!).toBeGreaterThan(180); // red point
    map.destroy();
  });
});

describe("passThrough append mixed geometry (engine path)", () => {
  // The incremental appendPassThrough → buildBatch → drawPassThrough(...,"append") path
  // must handle a geometry kind DIFFERENT from the initial layer: start with a Point layer,
  // append a Polygon. Both must end up rendered (the original is not cleared by the append).
  it("canvas: start with a Point, append a Polygon — both render", async () => {
    const h = host();
    const map = geoMap(h, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    const handle = map.layer("mixed", [mixedPoint()], {
      fill: mixedFill,
      stroke: mixedStroke,
      lineWidth: 4,
      pointRadius: 6,
      passThrough: true,
    });
    await map.whenReady();
    const ctx = canvasOf(h).getContext("2d")!;

    // Original point drew.
    const [ptx, pty] = mixedProject(-30, 30);
    expect(at(ctx, Math.round(ptx), Math.round(pty))[0]!).toBeGreaterThan(180); // red point

    // Append a Polygon through the engine (different geometry kind than the layer started with).
    handle.append([mixedPolygon()]);

    // Appended polygon appears...
    const [px, py] = mixedProject(10, 10);
    expect(at(ctx, Math.round(px), Math.round(py))[1]!).toBeGreaterThan(150); // green polygon
    // ...and the original point is still there (append draws on top, no clear).
    expect(at(ctx, Math.round(ptx), Math.round(pty))[0]!).toBeGreaterThan(180);
    map.destroy();
  });

  it("webgl: start with a Point, append a Polygon — both render (FBO accumulation)", async () => {
    const map = new GLGeoMap(host(), { width: 200, height: 200, projection: proj(), backend: "webgl" });
    const handle = map.layer("mixed", [mixedPoint()], {
      fill: mixedFill,
      stroke: mixedStroke,
      lineWidth: 4,
      pointRadius: 6,
      passThrough: true,
    });
    await map.whenReady();
    expect(map.liveBackendType()).toBe("webgl");

    const [ptx, pty] = mixedProject(-30, 30);
    expect(map.screenPixel(Math.round(ptx), Math.round(pty))[0]!).toBeGreaterThan(180); // red point

    handle.append([mixedPolygon()]); // "append" mode → tessellated polygon composited onto the FBO

    const [px, py] = mixedProject(10, 10);
    expect(map.screenPixel(Math.round(px), Math.round(py))[1]!).toBeGreaterThan(150); // green polygon
    expect(map.screenPixel(Math.round(ptx), Math.round(pty))[0]!).toBeGreaterThan(180); // point still there
    map.destroy();
  });
});

/**
 * #110 — TWO simultaneous pass-through layers.
 *
 * Before the fix these silently clobbered each other: the WebGL backend held ONE
 * `PassThroughGL` (one accumulation FBO) plus a single `ptScreen` flag overwritten by
 * whichever layer registered last, and the ENGINE started every layer's repaint with
 * `"replace-first"` — which clears (WebGL: the FBO; Canvas: the whole canvas). So the
 * second layer's repaint wiped the first, with no error and no warning.
 *
 * The fix keeps ONE shared accumulation surface (zero extra memory) and makes the clear
 * CYCLE-scoped instead of layer-scoped: one repaint pass walks every pass-through layer
 * in registration order, clears once at its first draw, and appends the rest. `sizeMode`
 * became per-layer on WebGL (it already was on Canvas).
 */
describe("multiple pass-through layers (#110)", () => {
  it("canvas: two pass-through layers both render (the second must not clobber the first)", async () => {
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    chart.points("a", [{ x: 50, y: 50 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    chart.points("b", [{ x: 140, y: 140 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(0,0,255)", passThrough: true });
    const ctx = canvasOf(h).getContext("2d")!;
    expect(at(ctx, 140, 140)[2]!).toBeGreaterThan(180); // second layer drew
    expect(at(ctx, 50, 50)[0]!).toBeGreaterThan(180);   // FIRST layer survived
    chart.destroy();
  });

  it("webgl: two pass-through layers both render (the second must not clobber the first)", async () => {
    const h = host();
    const chart = new GLPlot(h, { width: 200, height: 200, backend: "webgl" });
    await chart.whenReady();
    chart.points("a", [{ x: 50, y: 50 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    chart.points("b", [{ x: 140, y: 140 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(0,0,255)", passThrough: true });
    expect(chart.screenPixel(140, 140)[2]!).toBeGreaterThan(180); // second layer drew
    expect(chart.screenPixel(50, 50)[0]!).toBeGreaterThan(180);   // FIRST layer survived
    chart.destroy();
  });

  it("webgl: both layers survive a settle repaint (setTransform re-pulls every layer)", async () => {
    const h = host();
    const chart = new GLPlot(h, { width: 200, height: 200, backend: "webgl" });
    await chart.whenReady();
    chart.points("a", [{ x: 25, y: 25 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    chart.points("b", [{ x: 70, y: 70 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(0,0,255)", passThrough: true });
    chart.applyTransform({ k: 2, x: 0, y: 0 }); // programmatic (settle) transform → crisp repaint of BOTH
    expect(chart.screenPixel(50, 50)[0]!).toBeGreaterThan(180);   // layer a at k=2
    expect(chart.screenPixel(140, 140)[2]!).toBeGreaterThan(180); // layer b at k=2
    chart.destroy();
  });

  it("webgl: each pass-through layer keeps its OWN sizeMode (screen vs world)", async () => {
    const h = host();
    const chart = new GLPlot(h, { width: 200, height: 200, backend: "webgl" });
    await chart.whenReady();
    // a: screen sizing → constant 6 px radius at any zoom. b: world sizing (default) → 6·k.
    chart.points("a", [{ x: 25, y: 25 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(255,0,0)", sizeMode: "screen", passThrough: true });
    chart.points("b", [{ x: 70, y: 70 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(0,0,255)", passThrough: true });
    chart.applyTransform({ k: 2, x: 0, y: 0 });
    // a stays 6 px: its centre is red, 9 px out is empty.
    expect(chart.screenPixel(50, 50)[0]!).toBeGreaterThan(180);
    expect(chart.screenPixel(59, 50)[3]!).toBeLessThan(40);
    // b doubles to 12 px: its centre is blue AND 9 px out is still inside the disc.
    expect(chart.screenPixel(140, 140)[2]!).toBeGreaterThan(180);
    expect(chart.screenPixel(149, 140)[2]!).toBeGreaterThan(180);
    chart.destroy();
  });

  it("canvas: appending to one pass-through layer leaves the other untouched", async () => {
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    const a = chart.points("a", [{ x: 50, y: 50 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    chart.points("b", [{ x: 140, y: 140 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(0,0,255)", passThrough: true });
    a.append([{ x: 50, y: 140 }]);
    const ctx = canvasOf(h).getContext("2d")!;
    expect(at(ctx, 50, 140)[0]!).toBeGreaterThan(180);  // appended point
    expect(at(ctx, 50, 50)[0]!).toBeGreaterThan(180);   // layer a original
    expect(at(ctx, 140, 140)[2]!).toBeGreaterThan(180); // layer b untouched
    chart.destroy();
  });

  it("canvas: a retained-layer push repaints BOTH pass-through layers", async () => {
    const h = host();
    const chart = plot(h, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    chart.points("a", [{ x: 50, y: 50 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(255,0,0)", passThrough: true });
    chart.points("b", [{ x: 140, y: 140 }], { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "rgb(0,0,255)", passThrough: true });
    // A retained layer → pushLayers() → render() clears the canvas; both PT layers must come back.
    chart.points("base", [{ x: 100, y: 20 }], { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "rgb(0,180,0)" });
    const ctx = canvasOf(h).getContext("2d")!;
    expect(at(ctx, 100, 20)[1]!).toBeGreaterThan(150);  // retained base
    expect(at(ctx, 50, 50)[0]!).toBeGreaterThan(180);   // layer a
    expect(at(ctx, 140, 140)[2]!).toBeGreaterThan(180); // layer b
    chart.destroy();
  });
});
