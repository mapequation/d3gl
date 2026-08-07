import { describe, it, expect } from "vitest";
import { geoEquirectangular, type GeoProjection, type GeoStream } from "d3-geo";
import { geoMap } from "./geo-map.js";
import { perfBudget, perfN } from "../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames, zoomSteps } from "../__tests__/engine-sweep.js";

/**
 * ENGINE-level at-scale zoom sweep for `geoMap()` (#263, closing gap 2 of #258).
 *
 * `geo/__tests__/geo-zoom-sweep-perf.test.ts` already pins the *backend* seam: it builds a Scene by
 * hand and calls `CanvasBackend.setTransform()` + `.render()` against a counting 2D context. What it
 * cannot see is everything the **engine** does above that seam — `GeoMap.layer()`'s projection +
 * tessellation pass, the per-feature `fill`/`stroke`/`id` accessors, the retained `LayerDef`
 * bookkeeping, and `BaseEngine.setTransform`'s lane/declutter/label loop. That layer was only
 * exercised at the small N the behavioural browser tests use.
 *
 * This drives the real `geoMap(host).layer(...)` → `setTransform()` path at scale and pins the three
 * §5 signatures that hold for it. All three are deterministic — engine-level wall-clock at this size
 * is the flakiest thing available, so it is the backstop, not the assertion that carries the guard.
 *
 *   1. **The projection runs once per feature, at registration.** `geoPath` captures
 *      `projection.stream` when it is constructed and invokes it once per projected feature, so a
 *      counting wrapper on `.stream` is an exact, cast-free census of "how many features did we
 *      project". It must not tick at all during the sweep — a zoom is a GPU matrix change, never a
 *      re-projection.
 *   2. **`fill` / `stroke` / `id` resolve O(features) at registration, never O(visible) per frame.**
 *      Asserted in the N-invariant form (`toBe(before)`), which cannot go vacuous when the on-screen
 *      fraction shifts with N.
 *   3. **GPU buffers are updated in place, not destroyed + recreated — and nothing is re-uploaded
 *      into them.** Both counted on the live `WebGL2RenderingContext`, with non-vacuity checks that
 *      registration DID create buffers and DID upload. The two catch different regressions:
 *      re-pushing the same arrays into the same buffer every frame moves no create/delete count.
 */

// Local default keeps the always-on run ~0.4s of fixture build; the browser tier raises it via
// PERF_BROWSER_N (#262). `max`: past ~150k cells the one-time geoPath projection + tessellation
// (~1s locally, ×PERF_BUDGET_SCALE on SwiftShader) starts to dominate the tier's 300s per-file
// budget, and it is a CPU build cost, not the per-frame path this guard is about.
const N = perfN(20_000, { max: 150_000 });
const W = 640;
const H = 400;
// Measured worst frame (best-of-3 per step, local headless Chromium): 0.10ms at 20k, 0.10ms at
// 100k, 0.20ms at 150k — i.e. at or below Chromium's 100µs `performance.now()` quantum, because a
// geo zoom frame is a uniform write plus one indexed draw call. c0 covers that N-independent
// dispatch, c1 the backend's small per-frame scan. The ceiling is deliberately ~100x the measured
// value: it is the ORDER-OF-MAGNITUDE backstop behind the three deterministic signatures, not a
// millisecond policeman. The regression it must catch — re-projecting per frame — costs ~200ms at
// 20k and ~800ms at 100k, so the detection margin stays >20x at every N.
const FRAME_MS = perfBudget(6 + (6 * N) / 20_000);
// Registration is the O(N) phase (projection + tessellation + accessors), so the harness timeout
// scales with it. A timeout is a harness limit, not a budget (AGENTS.md §Tests).
const TEST_MS = perfBudget(60_000 + N / 10);

/** ~n quad cells covering the world, exterior rings CLOCKWISE in [lon, lat] (AGENTS.md winding rule). */
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
 * A projection that counts how many times `geoPath` streams a feature through it.
 *
 * `geoPath(projection)` captures `projection.stream` once and calls it per projected object, so this
 * counts projected features exactly — the cast-free probe for "was anything re-projected?".
 */
function countingProjection(): { projection: GeoProjection; streamed: () => number } {
  const projection = geoEquirectangular().scale(100).translate([W / 2, H / 2]);
  const original = projection.stream;
  let streamed = 0;
  projection.stream = function (this: GeoProjection, sink: GeoStream): GeoStream {
    streamed++;
    return original.call(this, sink);
  };
  return { projection, streamed: () => streamed };
}

describe(`geoMap() engine zoom sweep — per-frame cost at N=${N.toLocaleString()} cells (#263)`, () => {
  it("projects + resolves styles ONCE at registration and never re-derives or re-uploads per frame", async () => {
    const { projection, streamed } = countingProjection();
    const spy = new GlBufferSpy();
    try {
      let fillCalls = 0;
      let strokeCalls = 0;
      let idCalls = 0;

      const map = geoMap(perfHost(W, H), { width: W, height: H, projection, backend: "webgl" });
      await map.whenReady();

      const atStart = spy.mark();
      const buildStart = performance.now();
      map.layer("cells", makeCells(N), {
        fill: (_f, i) => {
          fillCalls++;
          return i % 2 ? "rgb(59,130,246)" : "rgb(16,185,129)";
        },
        stroke: (_f, _i) => {
          strokeCalls++;
          return "rgb(17,24,39)";
        },
        id: (_f, i) => {
          idCalls++;
          return i;
        },
        lineWidth: 0.5,
        pickable: false, // a hit index is a registration-time cost, orthogonal to the per-frame path
      });
      const buildMs = performance.now() - buildStart;
      const buildBuffers = spy.since(atStart);

      // Non-vacuity: the fixture really was projected and really does own GPU buffers, so the zeros
      // below mean "nothing recreated", not "nothing wired up".
      expect(fillCalls, "fill accessor never ran — fixture did not register").toBe(N);
      expect(strokeCalls).toBe(N);
      expect(idCalls).toBe(N);
      expect(streamed(), "geoPath never streamed the projection — the probe is not wired").toBeGreaterThan(0);
      expect(buildBuffers.created, "registration created no GPU buffer — the spy is not observing the live context").toBeGreaterThan(0);
      expect(buildBuffers.uploadedBytes, "registration uploaded no geometry — the spy is not observing the live context").toBeGreaterThan(0);

      const before = { fill: fillCalls, stroke: strokeCalls, id: idCalls, streamed: streamed() };
      const beforeSweep = spy.mark();
      const { worstFrameMs } = sweepFrames(zoomSteps(W, H), (t) => map.setTransform(t));
      const sweepBuffers = spy.since(beforeSweep);

      // Signature 1 — the projection is a registration cost, not a frame cost.
      expect(streamed(), "the projection was re-streamed during the zoom sweep").toBe(before.streamed);
      // Signature 2 — style accessors resolve O(features) at registration, not O(visible) per frame.
      expect(fillCalls, "fill accessor re-ran during the zoom sweep").toBe(before.fill);
      expect(strokeCalls, "stroke accessor re-ran during the zoom sweep").toBe(before.stroke);
      expect(idCalls, "id accessor re-ran during the zoom sweep").toBe(before.id);
      // Signature 3 — GPU buffers are updated in place, never destroyed + recreated per frame…
      expect(sweepBuffers.created, "GPU buffers were created during the zoom sweep").toBe(0);
      expect(sweepBuffers.deleted, "GPU buffers were destroyed during the zoom sweep").toBe(0);
      // …and nothing is re-uploaded into them either. Measured: exactly 0 bytes over the whole sweep
      // against 37MB at registration. Expressed as a ratio rather than `toBe(0)` so a future
      // per-frame UNIFORM write (a few hundred bytes) is not a false positive, while any geometry or
      // style re-upload — the smallest of which is a whole layer, i.e. ~1x the registration figure —
      // is 1000x over the line. This is the half of the #186 regression a create/delete count misses.
      expect(
        sweepBuffers.uploadedBytes,
        `${sweepBuffers.uploadedBytes.toLocaleString()} bytes re-uploaded during the zoom sweep (registration uploaded ${buildBuffers.uploadedBytes.toLocaleString()})`,
      ).toBeLessThan(buildBuffers.uploadedBytes / 1000);
      // Backstop: an order-of-magnitude frame-cost drop, in case a future regression dodges all three.
      expect(
        worstFrameMs,
        `worst frame ${worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()} (build ${buildMs.toFixed(0)}ms once)`,
      ).toBeLessThan(FRAME_MS);

      map.destroy();
    } finally {
      spy.restore();
    }
  }, TEST_MS);
});
