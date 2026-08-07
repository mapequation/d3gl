/**
 * Per-frame regression guard for the GEO polygon/stroke draw path on the **DEFAULT backend**, plus
 * the SVG leg (#264, sub-issue of #258).
 *
 * Geo's only per-frame guard used to be `geo/__tests__/geo-zoom-sweep-perf.test.ts`, which drives
 * the **Canvas** backend with a counting 2D context. WebGL is the backend a user gets by default,
 * and it composites geo through a completely different mechanism — retained `GroupRenderer`
 * geometry + a stencil clip + a mat3 uniform — none of which the Canvas guard can see. So the
 * shipped geo path had no per-frame guard at all. SVG had none either, at any scale.
 *
 * Both legs need the real thing (a GPU device; a real DOM whose mutations can be observed), which
 * is why they are here and not in the node guard.
 *
 * ## WebGL
 * The contract, and what a zoom frame must therefore cost:
 *   - projection (`geoPath` → `PathRecorder`) and tessellation run **ONCE**, at layer registration;
 *   - the GPU geometry/colour/flag objects are built **ONCE**, at `setLayers`;
 *   - a zoom frame is a `u_transform` mat3 write per **layer** plus one indexed draw per pass —
 *     `O(layers)` CPU work, never `O(polygons)`.
 *
 * Every regression that has actually happened on a d3gl render path (re-derive per frame, destroy +
 * recreate GPU buffers per frame, re-emit geometry on a view change) breaks one of those three, so
 * they are asserted as deterministic signatures — true at any machine speed, unlike a wall-clock
 * number under software GL. The frame budget is the backstop for whatever has no signature.
 *
 * ## SVG
 * A different contract for the same geo scene: the document is **retained**, so a world-mode zoom
 * must be exactly one `transform` attribute write on the view group and NOTHING else — no node
 * added or removed, no other attribute touched, and in particular no re-serialization of the N
 * `<path>` elements or the `<clipPath>`. A real `MutationObserver` over the whole `<svg>` subtree
 * makes that an exact, N-independent count rather than a timing.
 *
 * ## Reductions
 * Geo has **no LOD / declutter** for polygon layers (geo LOD is #151), so a geo layer is
 * always the full-detail draw — the "reductions OFF" state the core values require to stay
 * efficient. There is no second reduction state to test here; the aggregated-frontier case is
 * covered for the engines that have one (network `frontier-perf`, plot `points-lane-perf`).
 *
 * Cells are exterior-CW in [lon, lat] — a counter-clockwise ring is its own complement and fills
 * the whole map (AGENTS.md "GeoJSON winding").
 */
import { describe, it, expect } from "vitest";
import { geoEquirectangular, type GeoProjection, type GeoStream } from "d3-geo";
import { geoMap } from "./geo-map.js";
import { WebGLBackend } from "../webgl/webgl-backend.js";
import { groupRendererConstructions } from "../webgl/renderer.js";
import type { RenderLayer, RenderDelta, StyleTables, DrawableVector } from "../core/index.js";
import { perfBudget, perfN } from "../__tests__/perf-budget.js";

const W = 960;
const H = 600;

/**
 * Polygon count. Local default 30k (the always-on leg — one `GroupRenderer` with ~30k drawables,
 * each a quad fill + a stroked ring, built and uploaded once); the browser tier raises it via
 * `PERF_BROWSER_N` (CI: 100k).
 *
 * `max` — the wall this particular leg hits is the **one-time build**, not the frame: `geoPath` +
 * tessellation + upload is ~7 µs/polygon here, so 200k already spends ~1.4 s of the tier's 300 s
 * per-file budget on registration alone and grows linearly, while the per-frame cost it exists to
 * measure stays flat. (The `GrowTexture` style-table wall — 256 px wide, so ~2.1M drawables — is
 * far above that and never binds.) Clamping is not loosening: every assertion below holds exactly
 * at whatever N comes back.
 */
const N = perfN(30_000, { max: 200_000 });

/**
 * Polygon count for the SVG leg. Lower `max` than the WebGL leg because SVG's wall is a different
 * one: it materialises one real `<path>` **DOM node** per drawable, so the tier's N buys parse time
 * and heap, not assertion strength — every SVG signature below is an exact count that is identical
 * at 20k and at 1M. The plot SVG guard (`svg/__tests__/svg-zoom-sweep-perf.test.ts`) already holds
 * the one-time serialize budget at 100k / 1M.
 */
const SVG_N = perfN(20_000, { max: 60_000 });

/** Zoom steps. NOT a scale knob — scaling frames as well as N would make the guard quadratic. */
const SWEEP: readonly number[] = [1, 2, 4, 8, 16, 32];

/**
 * Worst single frame. The **constant** term is the real one and is deliberately dominant: the
 * CPU-side frame here is two mat3 uniform writes, a stencil-state switch and one indexed draw per
 * pass — measured 0.40 ms at 30k, 0.80 ms at 100k and 0.60 ms at 200k, i.e. flat in N. The small
 * linear term exists only because a **software** GL (SwiftShader, the CI runners) can charge part
 * of the O(N) rasterisation back to the submitting call, which a real GPU does not. Keeping it
 * small is the point: the regression this backs up — a per-frame re-projection / re-tessellation —
 * costs about one registration (250 ms at 30k, 670 ms at 100k), so it still overshoots by 15-40×.
 * Scaling the whole ceiling by N/30k instead would inflate the constant and hide exactly that.
 */
const FRAME_MS = perfBudget(6 + 8 * (N / 30_000));

/**
 * One-time registration (project + tessellate + upload N polygons): measured 251 ms at 30k, 672 ms
 * at 100k, 1370 ms at 200k — linear, ~4.4 µs/polygon, with ~120 ms of fixed engine cost. Not a
 * per-frame budget; it is here so a build blow-up fails as a budget rather than as the tier's 300 s
 * per-file kill, and so the `max` on N above stays honest.
 */
const BUILD_MS = perfBudget(400 + 700 * (N / 30_000));

/**
 * SVG worst frame. Constant in N on purpose, with no linear term at all: `SvgBackend.setTransform`
 * for all-world content is literally one `setAttribute` and the engine's following `render()`
 * no-ops (`dirty` stays false), so the frame does not touch the drawables. A term that grew with N
 * would only make room for the very regression this leg exists to catch — a per-frame re-serialize
 * of the N `<path>` nodes: with that regression injected the frame measures 76 ms at 20k, against a
 * clean 0.10 ms.
 */
const SVG_FRAME_MS = perfBudget(25);

/** The harness limit: build + sweep + the WebGL device handshake + the PNG readback. A timeout is
 *  a harness limit, not a budget (AGENTS.md §Tests). */
const TEST_MS = perfBudget(20_000 + 20_000 * (N / 30_000));

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

/** ~n quad cells covering the world, exterior rings CLOCKWISE in [lon, lat]. */
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

/**
 * A projection that counts its `stream` invocations. `geoPath(projection)(feature)` calls
 * `projection.stream(sink)` exactly once per feature, so this counts **re-projections** —
 * the geo-specific "work the baseline did once" that a per-frame regression would repeat.
 */
function countingProjection(): { proj: GeoProjection; streams: () => number } {
  const proj = geoEquirectangular().scale(150).translate([W / 2, H / 2]);
  let streams = 0;
  const orig = proj.stream.bind(proj);
  proj.stream = (sink: GeoStream): GeoStream => {
    streams++;
    return orig(sink);
  };
  return { proj, streams: () => streams };
}

/**
 * Count every geometry / style WRITE reaching any WebGLBackend.
 *
 * These five methods are the ONLY ways geometry, colour tables or flags are (re)written after a
 * layer is registered — `setTransform` and `render` touch nothing but a uniform and the draw call.
 * Zero of them during a sweep, together with a zero delta on `groupRendererConstructions`, is proof
 * that the frame re-derived, re-allocated and re-uploaded *nothing*: exactly the "a path that
 * re-uploads per frame what the old path retained is a regression" rule (AGENTS.md lifecycle §5).
 * Patching the prototype rather than an instance catches the backend the engine builds internally.
 */
interface BackendWatch {
  writes: () => number;
  restore: () => void;
}
function watchWebGL(): BackendWatch {
  let n = 0;
  const setLayers = WebGLBackend.prototype.setLayers;
  const updateLayer = WebGLBackend.prototype.updateLayer;
  const appendToLayer = WebGLBackend.prototype.appendToLayer;
  const updateLayerStyles = WebGLBackend.prototype.updateLayerStyles;
  const updateLayerFlags = WebGLBackend.prototype.updateLayerFlags;
  WebGLBackend.prototype.setLayers = function (this: WebGLBackend, layers: RenderLayer[]): void {
    n++;
    setLayers.call(this, layers);
  };
  WebGLBackend.prototype.updateLayer = function (this: WebGLBackend, name: string, layer: RenderLayer): void {
    n++;
    updateLayer.call(this, name, layer);
  };
  WebGLBackend.prototype.appendToLayer = function (this: WebGLBackend, delta: RenderDelta): void {
    n++;
    appendToLayer.call(this, delta);
  };
  WebGLBackend.prototype.updateLayerStyles = function (
    this: WebGLBackend,
    name: string,
    tables: StyleTables,
    drawables?: DrawableVector[],
  ): void {
    n++;
    updateLayerStyles.call(this, name, tables, drawables);
  };
  WebGLBackend.prototype.updateLayerFlags = function (this: WebGLBackend, name: string, flags: Uint8Array): void {
    n++;
    updateLayerFlags.call(this, name, flags);
  };
  return {
    writes: () => n,
    restore: () => {
      WebGLBackend.prototype.setLayers = setLayers;
      WebGLBackend.prototype.updateLayer = updateLayer;
      WebGLBackend.prototype.appendToLayer = appendToLayer;
      WebGLBackend.prototype.updateLayerStyles = updateLayerStyles;
      WebGLBackend.prototype.updateLayerFlags = updateLayerFlags;
    },
  };
}

/** Non-transparent pixel count of the engine's own PNG export — "the sweep actually drew geo". */
async function paintedPixels(png: string): Promise<number> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("could not decode the exported PNG"));
    img.src = png;
  });
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2D context for the PNG check");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) {
    const alpha = data[i];
    if (alpha !== undefined && alpha > 0) painted++;
  }
  return painted;
}

describe(`geo full-detail zoom sweep on WebGL (#264) — ${N.toLocaleString()} polygons`, () => {
  it("projects + uploads once; a setTransform sweep re-derives nothing and holds the frame budget", async () => {
    const { proj, streams } = countingProjection();
    const cells = makeCells(N);
    let fillCalls = 0;
    let strokeCalls = 0;
    const watch = watchWebGL();
    const h = host();
    try {
      const map = geoMap(h, { width: W, height: H, projection: proj, backend: "webgl" });
      await map.whenReady();

      const build0 = performance.now();
      // A clip source + a clipped full-detail layer: the geo shape the Canvas guard pins, here on
      // the stencil path. `pickable: false` keeps the CPU hit index (a registration-time, not
      // per-frame, cost) out of the measurement.
      map.layer("sphere", [{ type: "Sphere" }], { fill: "rgb(10,20,60)", lineWidth: 1 });
      map.layer("cells", cells, {
        fill: (_f, i) => { fillCalls++; return i % 2 ? "rgb(60,120,80)" : "rgb(80,140,100)"; },
        stroke: () => { strokeCalls++; return "rgb(240,240,240)"; },
        lineWidth: 0.5,
        clipTo: "sphere",
        id: (_f, i) => i,
        pickable: false,
      });
      const buildMs = performance.now() - build0;

      // Registration really did the O(N) work once (else everything below is vacuous).
      expect(fillCalls).toBe(N);
      expect(strokeCalls).toBe(N);
      expect(streams()).toBeGreaterThanOrEqual(N);

      const baseStreams = streams();
      const baseFill = fillCalls;
      const baseStroke = strokeCalls;
      const baseWrites = watch.writes();
      const baseRenderers = groupRendererConstructions;

      // The real trigger: a zoom sweep through the engine's public setTransform (emit → render).
      let worstFrameMs = 0;
      const sweep0 = performance.now();
      for (const k of SWEEP) {
        const t = { k, x: (W / 2) * (1 - k), y: (H / 2) * (1 - k) };
        const f0 = performance.now();
        map.setTransform(t);
        worstFrameMs = Math.max(worstFrameMs, performance.now() - f0);
      }
      const sweepMs = performance.now() - sweep0;

      // Signature 1 — no re-projection: `geoPath` ran at registration, never per frame.
      expect(streams() - baseStreams, "the projection was re-streamed during the zoom sweep").toBe(0);
      // Signature 2 — no accessor re-resolution: fill/stroke are O(data) at registration.
      expect(fillCalls - baseFill, "the fill accessor re-ran during the zoom sweep").toBe(0);
      expect(strokeCalls - baseStroke, "the stroke accessor re-ran during the zoom sweep").toBe(0);
      // Signature 3 — no geometry/style write reached the backend: the frame is a uniform + a draw.
      expect(watch.writes() - baseWrites, "geometry/styles were re-pushed to the backend per frame").toBe(0);
      // Signature 4 — no GPU object churn: the retained renderers (≈10 GPU objects each) are reused.
      expect(groupRendererConstructions - baseRenderers, "a GroupRenderer was rebuilt during the sweep").toBe(0);

      // Budgets.
      expect(buildMs, `registration took ${buildMs.toFixed(0)}ms at N=${N.toLocaleString()}`).toBeLessThan(BUILD_MS);
      expect(worstFrameMs, `worst frame ${worstFrameMs.toFixed(1)}ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS);
      // Machine-relative backstop, immune to both the tier's N and the runner's speed: the WHOLE
      // sweep must cost a fraction of ONE registration. A frame that re-projects/re-tessellates
      // costs about a registration each, so this inverts by ~24× the moment one does. It cannot go
      // vacuous as N grows either — the build is O(N) while the frame measured flat.
      expect(
        sweepMs,
        `sweep ${sweepMs.toFixed(1)}ms vs one registration ${buildMs.toFixed(0)}ms (${SWEEP.length} frames)`,
      ).toBeLessThan(buildMs / 4);

      // Non-vacuity: the sweep really painted geo (a blank canvas would satisfy every count above).
      expect(await paintedPixels(map.toPNG())).toBeGreaterThan(0);
      map.destroy();
    } finally {
      watch.restore();
      h.remove();
    }
  }, TEST_MS);
});

describe(`geo full-detail zoom sweep on SVG (#264) — ${SVG_N.toLocaleString()} polygons`, () => {
  it("keeps the whole geo document retained: a zoom is one transform attribute and nothing else", async () => {
    const { proj, streams } = countingProjection();
    const cells = makeCells(SVG_N);
    const h = host();
    try {
      const map = geoMap(h, { width: W, height: H, projection: proj, backend: "svg" });
      await map.whenReady();
      map.layer("sphere", [{ type: "Sphere" }], { fill: "rgb(10,20,60)", lineWidth: 1 });
      map.layer("cells", cells, {
        fill: "rgb(60,120,80)", stroke: "rgb(240,240,240)", lineWidth: 0.5,
        clipTo: "sphere", id: (_f, i) => i, pickable: false,
      });

      const svg = h.querySelector("svg");
      if (!svg) throw new Error("the SVG backend did not create its root element");
      // Non-vacuity: the N polygons really are in the DOM, and the clip really is a <clipPath>.
      expect(svg.querySelectorAll("path").length).toBeGreaterThanOrEqual(SVG_N);
      expect(svg.querySelectorAll("clipPath").length).toBeGreaterThan(0);

      const baseStreams = streams();
      // Observe the ENTIRE document, so "nothing else happened" is a fact about every node in it.
      const obs = new MutationObserver(() => {});
      obs.observe(svg, { childList: true, subtree: true, attributes: true, characterData: true });

      let worstFrameMs = 0;
      for (const k of SWEEP) {
        const t = { k, x: (W / 2) * (1 - k), y: (H / 2) * (1 - k) };
        const f0 = performance.now();
        map.setTransform(t);
        worstFrameMs = Math.max(worstFrameMs, performance.now() - f0);
      }
      // takeRecords() drains synchronously — no waiting on the observer's microtask.
      const records = obs.takeRecords();
      obs.disconnect();

      // Signature — the retained document stands: not one node added or removed by a zoom. A
      // re-serialize regression rewrites the view group's children and lands here, at any N.
      const structural = records.filter((r) => r.type !== "attributes");
      expect(structural.map((r) => r.type), "the SVG document was rebuilt during the zoom sweep").toEqual([]);
      // Signature — O(1) per frame: exactly one `transform` write per sweep step, nothing else.
      expect(records.map((r) => r.attributeName)).toEqual(SWEEP.map(() => "transform"));
      // Signature — no re-projection (the same geo contract the WebGL leg asserts).
      expect(streams() - baseStreams, "the projection was re-streamed during the zoom sweep").toBe(0);
      // Budget: an attribute write is orders below any redraw, at every N — so a constant ceiling.
      expect(worstFrameMs, `svg worst frame ${worstFrameMs.toFixed(2)}ms`).toBeLessThan(SVG_FRAME_MS);
      map.destroy();
    } finally {
      h.remove();
    }
  }, TEST_MS);
});
