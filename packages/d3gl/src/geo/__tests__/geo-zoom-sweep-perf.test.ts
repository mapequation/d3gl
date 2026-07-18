import { describe, it, expect, beforeAll } from "vitest";
import { geoEquirectangular, type GeoSphere } from "d3-geo";
import { Scene } from "../../core/scene.js";
import type { RenderLayer, ViewTransform } from "../../core/index.js";
import { geoLayer } from "../geo-layer.js";

/**
 * Per-frame regression guard for the GEO full-detail zoom sweep (#220, AGENTS.md lifecycle §5).
 *
 * The geo pipeline's cost split is: projection + tessellation (geoPath → Scene drawables) happens
 * ONCE at layer registration; a zoom is then only the backend trigger (`setTransform` + `render`)
 * over the retained drawables. This drives that trigger over a full-detail polygon-cell layer
 * (reductions OFF — no LOD/declutter, the case the core values require to stay efficient) through
 * the Canvas backend with a counting 2D context, and asserts:
 *   1. **Signature — one path per polygon per frame:** `beginPath` runs exactly once per visible
 *      drawable per frame and the total vertex-tracing work (`lineTo`) is identical on every
 *      frame — any per-frame re-projection, re-tessellation, or double-draw shifts these counts
 *      deterministically, at any speed.
 *   2. **Signature — clip built ONCE:** the clip silhouette (`Path2D`) for the clipped cells
 *      layer is constructed once for the whole sweep, never per frame.
 *   3. **Frame budget:** each frame's backend CPU work holds a generous wall-clock ceiling.
 *
 * Cells are exterior-CW in [lon, lat] (see AGENTS.md "GeoJSON winding"). ~15k cells run in the
 * normal suite; the at-scale leg is env-gated (BENCH_GEO_SWEEP=1, picked up by
 * scripts/run-perf-tier.mjs) — its N is the dominant one-time geoPath build, bounded by the
 * tier's per-file budget, while the same per-frame signatures hold.
 */
class FakePath2D {
  static constructed = 0;
  constructor() { FakePath2D.constructed++; }
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  closePath(): void {}
}

/** A 2D context with cheap dedicated counters for the calls the signatures pin. */
class CountingCtx {
  beginPaths = 0;
  lineTos = 0;
  fills = 0;
  setTransform(): void {}
  clearRect(): void {}
  save(): void {}
  restore(): void {}
  beginPath(): void { this.beginPaths++; }
  moveTo(): void {}
  lineTo(): void { this.lineTos++; }
  closePath(): void {}
  arc(): void {}
  rect(): void {}
  clip(): void {}
  fill(): void { this.fills++; }
  stroke(): void {}
  set fillStyle(_v: string) {}
  set strokeStyle(_v: string) {}
  set lineWidth(_v: number) {}
  set lineJoin(_v: string) {}
  set miterLimit(_v: number) {}
  set lineCap(_v: string) {}
}

let CanvasBackend: typeof import("../../canvas/canvas-backend.js").CanvasBackend;

beforeAll(async () => {
  (globalThis as { Path2D?: unknown }).Path2D = FakePath2D;
  ({ CanvasBackend } = await import("../../canvas/canvas-backend.js"));
});

const W = 1280;
const H = 800;

function fakeCanvas(ctx: CountingCtx) {
  return { getContext: () => ctx, width: W, height: H } as unknown as HTMLCanvasElement;
}

const layerOf = (s: Scene, name: string, clipTo?: string): RenderLayer => ({
  name, buffers: s.buffers(name), drawables: s.drawables(name), clipTo,
});

/** ~n quad cells covering the world, exterior rings CLOCKWISE in [lon, lat] (AGENTS winding rule). */
function makeCells(n: number): GeoJSON.Polygon[] {
  const lonSteps = Math.ceil(Math.sqrt(n * (360 / 170)));
  const latSteps = Math.ceil(n / lonSteps);
  const dLon = 360 / lonSteps;
  const dLat = 170 / latSteps; // ±85° — skip the poles
  const cells: GeoJSON.Polygon[] = [];
  for (let i = 0; i < lonSteps && cells.length < n; i++) {
    for (let j = 0; j < latSteps && cells.length < n; j++) {
      const lon = -180 + i * dLon;
      const lat = 85 - j * dLat; // top edge of the cell
      cells.push({
        type: "Polygon",
        coordinates: [[[lon, lat], [lon + dLon, lat], [lon + dLon, lat - dLat], [lon, lat - dLat], [lon, lat]]],
      });
    }
  }
  return cells;
}

interface SweepResult {
  buildMs: number;
  worstFrameMs: number;
  drawableCount: number;
  beginPathsPerFrame: number[];
  lineTosPerFrame: number[];
  path2dBuilt: number;
}

function zoomSweep(n: number): SweepResult {
  const proj = geoEquirectangular().scale(200).translate([W / 2, H / 2]);
  const scene = new Scene();
  const b0 = performance.now();
  const sphere: GeoSphere = { type: "Sphere" };
  scene.group("sphere", geoLayer([sphere], proj, { lineWidth: 1 }));
  scene.group("cells", geoLayer(makeCells(n), proj, { lineWidth: 0.5 }));
  scene.setFill("sphere", 0, "rgb(10,20,60)");
  const buildMs = performance.now() - b0; // projection + tessellation — ONCE, at registration
  const drawables = scene.drawables("cells");
  for (const d of drawables) scene.setFill("cells", d.id, "rgb(60,120,80)");

  const ctx = new CountingCtx();
  const backend = new CanvasBackend(fakeCanvas(ctx), W, H);
  backend.setLayers([layerOf(scene, "sphere"), layerOf(scene, "cells", "sphere")]);
  backend.setTransform({ k: 1, x: 0, y: 0 });
  backend.render(); // initial paint (builds + caches the clip)
  const p2dAfterFirst = FakePath2D.constructed;

  const sweep: ViewTransform[] = [1, 2, 4, 8, 16, 32].map((m) => ({ k: m, x: (W / 2) * (1 - m), y: (H / 2) * (1 - m) }));
  const beginPathsPerFrame: number[] = [];
  const lineTosPerFrame: number[] = [];
  let worstFrameMs = 0;
  for (const t of sweep) {
    let best = Infinity;
    let beginPaths = 0;
    let lineTos = 0;
    for (let rep = 0; rep < 3; rep++) {
      const bp0 = ctx.beginPaths;
      const lt0 = ctx.lineTos;
      const t0 = performance.now();
      backend.setTransform(t);
      backend.render();
      best = Math.min(best, performance.now() - t0);
      beginPaths = ctx.beginPaths - bp0;
      lineTos = ctx.lineTos - lt0;
    }
    beginPathsPerFrame.push(beginPaths);
    lineTosPerFrame.push(lineTos);
    worstFrameMs = Math.max(worstFrameMs, best);
  }
  return { buildMs, worstFrameMs, drawableCount: drawables.length + 1, beginPathsPerFrame, lineTosPerFrame, path2dBuilt: FakePath2D.constructed - p2dAfterFirst };
}

describe("geo full-detail zoom sweep (project once, per-frame cost pinned)", () => {
  it("traces each polygon exactly once per frame, reuses the clip, and holds the frame budget at ~15k cells", () => {
    const r = zoomSweep(15_000);
    // Signature 1: one path per drawable per frame (sphere + cells), constant vertex work.
    for (const bp of r.beginPathsPerFrame) expect(bp).toBe(r.drawableCount);
    for (const lt of r.lineTosPerFrame) expect(lt).toBe(r.lineTosPerFrame[0]);
    expect(r.lineTosPerFrame[0]).toBeGreaterThan(0);
    // Signature 2: the clip silhouette is NOT rebuilt per frame.
    expect(r.path2dBuilt).toBe(0);
    // Frame budget: generous ceiling for the ~15k-path trace loop on a shared runner.
    expect(r.worstFrameMs).toBeLessThan(300);
  });

  it.runIf(process.env.BENCH_GEO_SWEEP)(
    "at-scale leg: same signatures at large N (env-gated; run by the CI perf tier)",
    () => {
      const N = Number(process.env.BENCH_GEO_SWEEP_N) || 500_000;
      const ceiling = Number(process.env.PERF_GEO_FRAME_MS) || 3000;
      const r = zoomSweep(N);
      for (const bp of r.beginPathsPerFrame) expect(bp).toBe(r.drawableCount);
      for (const lt of r.lineTosPerFrame) expect(lt).toBe(r.lineTosPerFrame[0]);
      expect(r.path2dBuilt).toBe(0);
      console.log(`geo sweep N=${N.toLocaleString()}: build ${r.buildMs.toFixed(0)}ms (once), worst frame ${r.worstFrameMs.toFixed(1)}ms (ceiling ${ceiling}ms)`);
      expect(r.worstFrameMs).toBeLessThan(ceiling);
    },
    240_000,
  );
});
