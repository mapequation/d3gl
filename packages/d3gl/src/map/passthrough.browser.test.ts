import { describe, it, expect, afterEach } from "vitest";
import { geoEquirectangular } from "d3-geo";
import type { PassThroughLayer, PointBatch } from "../core/index.js";
import { CanvasBackend } from "../canvas/canvas-backend.js";
import { BaseEngine } from "./base-engine.js";
import { plot, Plot } from "./plot.js";
import type { PlotOptions } from "./plot.js";
import { geoMap } from "./geo-map.js";
import { LayerHandle } from "./layer-handle.js";
import { createCanvasBackend, type BackendHandle } from "./backend-factory.js";

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

  it("non-Point geometry under passThrough throws on projection", async () => {
    const map = geoMap(host(), { width: 200, height: 200, projection: proj(), backend: "canvas" });
    // Registration defers (no backend live yet); the backend install replays it, and the repaint
    // that projects the Polygon throws — surfacing via whenReady().
    map.layer("bad", [polygon()], { fill: "red", passThrough: true });
    await expect(map.whenReady()).rejects.toThrow(/passThrough supports only Point geometry in Phase 1/);
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

describe('passThrough "auto" backend upgrade guard (Phase 1: WebGL has no PT)', () => {
  // The "auto" backend starts on Canvas then upgrades to WebGL in the background. WebGL has no
  // pass-through support in Phase 1. Without the guard, the upgrade would destroy the canvas
  // (losing the PT raster) and THROW at installBackend's unsupported-backend check (an unhandled
  // rejection, plus the points vanish). The fix aborts the upgrade and stays on canvas.
  //
  // We drive the upgrade deterministically by stubbing createWebGLBackend (the protected test
  // seam) to return a backend whose supportsPassThrough is falsy — exactly like the real WebGL
  // backend — without spinning up a real GPU device (flaky in headless browsers). The subclass
  // exposes the private upgradeDone promise so the test can await the upgrade window precisely.
  class StubPlot extends Plot {
    stubbedWebGL: BackendHandle | null = null;
    constructor(host: HTMLElement, opts: PlotOptions) { super(host, opts); }
    protected createWebGLBackend(): Promise<BackendHandle> {
      // A canvas-backed handle is a fully-working backend, but we force supportsPassThrough falsy
      // to mimic WebGL (no PT support yet). Real WebGLBackend leaves the flag undefined too.
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
    await expect(chart.whenReady()).rejects.toThrow(/passThrough is not supported.*canvas backend; WebGL pass-through is not yet supported/);
    chart.destroy();
  });
});
