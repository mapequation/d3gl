/**
 * #280 — `pushLayers()` must not re-materialize the vector view of every layer on every push.
 *
 * `BaseEngine.pushLayers()` → `allRenderLayers()` → `renderLayer(spec)` calls
 * `Scene.drawables(name)` for each layer. That used to build a fresh `DrawableVector` per drawable
 * (plus two colour tuples each) every single time — O(total drawables) in time and allocation
 * BEFORE any backend saw the result, on every backend, even though WebGL renders from the typed
 * buffers and only stashes the vector view for export.
 *
 * Pushes are not per-frame, but they are frequent and user-facing: once per `registerLayer` (an
 * L-layer map pays L×, each push re-doing every layer already registered), on `removeLayer`, on
 * `setClip`, on every backend install, and at BOTH boundaries of every gesture on a map carrying a
 * `hideOnInteraction` layer — i.e. a hitch at the start and the end of each drag.
 *
 * The assertion here is the **deterministic signature**, which is scale-free: across many real
 * pushes the engine obtains exactly ONE vector view per layer per drawable set. Wall-clock cannot
 * carry this leg, and that is measured, not assumed — a push also repaints (Canvas `drawShapes`
 * over every drawable) or rebuilds every `GroupRenderer` (WebGL), and those dominate the
 * materialization they surround. One gesture-end push, before → after:
 *
 *     20,000 polygons,  Canvas:   9.0 →  8.9 ms   (below the noise floor)
 *    120,000 polygons,  Canvas:  99.4 → 87.7 ms   (−12%; the repaint dominates)
 *    120,000 polygons,  WebGL:   27.9 → 19.2 ms   (−31%; WebGL never renders from the view)
 *
 * A ceiling loose enough not to flake on the first row cannot see the regression in the third. So
 * the budget below is a secondary sanity bound; the sensitive one lives at the Scene seam at 1M
 * drawables — `core/__tests__/vector-view-perf.test.ts` (20 pushes: 31,385 → 0.04 ms).
 */
import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { GeoMap, type GeoMapOptions } from "./geo-map.js";
import type { Scene, DrawableVector } from "../core/index.js";
import { perfBudget, perfN } from "../__tests__/perf-budget.js";

const W = 800;
const H = 600;

/** One drawable per polygon. Same fixture size as the #273 geo leg, same cap rationale. */
const CELLS = perfN(20_000, { max: 120_000 });
/** A tiny second layer that opts into `hideOnInteraction`, so a gesture boundary re-pushes. */
const MARKS = 50;

/**
 * Secondary sanity bound for one gesture-end push (setLayers + full Canvas repaint of every
 * drawable). Split into its constant and linear terms so it reduces to the local default's number
 * at 20k and grows with the tier's N. Measured 8.9 ms at 20k and 87.7 ms at 120k, so this is ~10×
 * headroom at both ends — deliberately generous, because the repaint dominates (see the header).
 */
const PUSH_BUDGET_MS = perfBudget(100 + (800 * CELLS) / 20_000);

/**
 * Test seam: `scene` and `setInteracting` are `protected` on `BaseEngine`, which is exactly what
 * a subclass is for — no cast, no reach into privates.
 */
class ProbeMap extends GeoMap {
  /** The engine's retained Scene. */
  get sceneView(): Scene {
    return this.scene;
  }
  /** Drive a gesture boundary the way the d3-zoom "start"/"end" handlers do. */
  gesture(v: boolean): void {
    this.setInteracting(v);
  }
}

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

/** `n` small square cells tiled over the globe, wound CLOCKWISE in [lon, lat] (see AGENTS.md). */
function makeCells(n: number): GeoJSON.Feature[] {
  const cols = Math.ceil(Math.sqrt(n * 2));
  const rows = Math.ceil(n / cols);
  const dx = 360 / cols;
  const dy = 180 / rows;
  return Array.from({ length: n }, (_, i) => {
    const x = -180 + (i % cols) * dx;
    const y = -90 + Math.floor(i / cols) * dy;
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + dy], [x + dx, y + dy], [x + dx, y], [x, y]]] },
    } satisfies GeoJSON.Feature;
  });
}

const marks = (n: number): GeoJSON.Feature[] =>
  Array.from({ length: n }, (_, i) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [(i * 7) % 360 - 180, ((i * 13) % 180) - 90] },
  }) satisfies GeoJSON.Feature);

/**
 * Record every FULL vector view (`from` omitted/0) the engine pulls out of the Scene, per layer.
 * Shadowing the instance method is the same typed spy pattern the #208 guard uses on the backend
 * seam. Tail reads (`from > 0`, the append path) are deliberately not counted: those are O(new)
 * by construction and are handed to the backend to own.
 */
function watchViews(scene: Scene): { views: Map<string, Set<DrawableVector[]>>; reads: Map<string, number> } {
  const views = new Map<string, Set<DrawableVector[]>>();
  const reads = new Map<string, number>();
  const original = scene.drawables.bind(scene);
  scene.drawables = (name: string, from = 0): DrawableVector[] => {
    const out = original(name, from);
    if (from === 0) {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      let set = views.get(name);
      if (!set) { set = new Set(); views.set(name, set); }
      set.add(out);
    }
    return out;
  };
  return { views, reads };
}

function makeMap(backend: GeoMapOptions["backend"]): ProbeMap {
  return new ProbeMap(host(), {
    width: W,
    height: H,
    projection: geoEquirectangular().scale(120).translate([W / 2, H / 2]),
    backend,
  });
}

describe(`pushLayers() reuses the retained vector view (#280) — ${CELLS} polygons`, () => {
  for (const backend of ["canvas", "webgl"] as const) {
    it(`${backend}: many real pushes materialize ONE view per layer, not one per push`, async () => {
      const map = makeMap(backend);
      await map.whenReady();
      map.layer("cells", makeCells(CELLS), { fill: "rgb(200,60,60)", id: (_d, i) => i, pickable: false });
      map.layer("marks", marks(MARKS), { fill: "rgb(20,20,220)", pointRadius: 3, id: (_d, i) => i, hideOnInteraction: true });

      // Watch AFTER registration: registration itself legitimately materializes each layer once.
      const baseline = map.sceneView.drawables("cells");
      const spy = watchViews(map.sceneView);

      // Six real pushes through three different public/gesture triggers.
      for (let g = 0; g < 2; g++) {
        map.gesture(true); // d3-zoom "start" → pushLayers (a hideOnInteraction layer is present)
        map.gesture(false); // "end" → pushLayers
      }
      map.setClip("marks", "cells"); // → pushLayers
      map.setClip("marks", undefined); // → pushLayers

      // Non-vacuity: the pushes really did read the full view (6 pushes; "marks" drops out of
      // renderSpecs() on the two gesture-start pushes, hence 4).
      expect(spy.reads.get("cells")).toBe(6);
      expect(spy.reads.get("marks")).toBe(4);

      // THE signature: one array per layer across all of them — no re-materialization per push.
      expect(spy.views.get("cells")?.size).toBe(1);
      expect(spy.views.get("marks")?.size).toBe(1);
      expect([...(spy.views.get("cells") ?? [])][0]).toBe(baseline);

      // Non-vacuity 2: a genuine data change DOES produce a new view.
      map.layer("cells", makeCells(CELLS), { fill: "rgb(60,200,60)", id: (_d, i) => i, pickable: false });
      expect(map.sceneView.drawables("cells")).not.toBe(baseline);

      map.destroy();
    }, perfBudget(120_000));
  }

  it("canvas: a gesture-end push stays within its (repaint-dominated) budget", async () => {
    const map = makeMap("canvas");
    await map.whenReady();
    map.layer("cells", makeCells(CELLS), { fill: "rgb(200,60,60)", id: (_d, i) => i, pickable: false });
    map.layer("marks", marks(MARKS), { fill: "rgb(20,20,220)", pointRadius: 3, id: (_d, i) => i, hideOnInteraction: true });

    const ts: number[] = [];
    for (let g = 0; g < 5; g++) {
      map.gesture(true);
      const t0 = performance.now();
      map.gesture(false); // the gesture-END push: every layer back in, full setLayers + repaint
      ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    const median = ts[Math.floor(ts.length / 2)]!;
    console.log(`#280 gesture-end push (canvas, ${CELLS} polygons): median ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(PUSH_BUDGET_MS);
    map.destroy();
  }, perfBudget(120_000));
});
