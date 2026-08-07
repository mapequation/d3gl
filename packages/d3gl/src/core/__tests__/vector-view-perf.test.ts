import { describe, it, expect } from "vitest";
import { Scene, type DrawableVector } from "../scene.js";

/**
 * Guard for the retained vector view (#280).
 *
 * `BaseEngine.pushLayers()` builds one `RenderLayer` per layer, and every one of them calls
 * `Scene.drawables(name)` + `Scene.buffers(name)`. `drawables()` used to materialize a FRESH
 * `DrawableVector` per drawable (plus two colour tuples each) on every call, and `buffers()` a
 * fresh stride-4 `pointCenters` — so a push cost O(total drawables) in time AND allocation
 * *before any backend saw the result*, on every backend. Measured at 200k: ~0.16 µs and ~320 B
 * per drawable, i.e. ≈160 ms and ≈320 MB of short-lived garbage per push at 1M.
 *
 * `pushLayers()` is not the draw loop, but it is not rare either: it runs once per
 * `registerLayer` (an L-layer map pays L×), on `removeLayer`, on `setClip`, on every backend
 * install, and — the user-visible one — at BOTH boundaries of every gesture on a map with a
 * `hideOnInteraction` layer. That is a hitch at the start and end of each drag.
 *
 * The fix retains the array per drawable set (it was already retained downstream by whichever
 * backend it was pushed to, so this shares one instead of minting a copy per push) and re-applies
 * style writes IN PLACE, reusing the same objects and colour tuples.
 *
 * What is asserted here:
 *   1. **Signature — materialize once per drawable set, not once per push:** repeated pushes hand
 *      back the identical array AND the identical element objects, and across many pushes the
 *      total number of distinct `DrawableVector` objects ever produced is exactly N (not pushes×N).
 *      Non-vacuity: an append and a rebuild each DO produce a new set.
 *   2. **Push budget at 1M drawables**, in both regimes a real engine hits: pushes with nothing
 *      changed (`setClip`, a backend install), and pushes preceded by a declutter flags write
 *      (the gesture-end push).
 */

const N = 1_000_000;
/** Pushes to simulate. A 5-layer map already pays 5 during registration alone. */
const PUSHES = 20;

function pointScene(n: number, name = "pts"): Scene {
  const scene = new Scene();
  scene.group(name, (g) => {
    for (let i = 0; i < n; i++) g.point(i, (i % 1000) * 3, Math.floor(i / 1000) * 3, 2);
  });
  return scene;
}

/** Exactly what `BaseEngine.renderLayer()` reads out of the Scene for one layer. */
function renderLayer(scene: Scene, name: string): { drawables: DrawableVector[]; pointCenters: Float32Array } {
  return { drawables: scene.drawables(name), pointCenters: scene.buffers(name).pointCenters };
}

describe("Scene vector view is retained per drawable set (#280)", () => {
  it("signature: repeated pushes reuse one materialization; a data change makes a new one", () => {
    // Modest N so the distinct-object Set below stays cheap — this leg is about counting, not scale.
    const n = 20_000;
    const scene = pointScene(n);

    const seen = new Set<DrawableVector>();
    const first = renderLayer(scene, "pts");
    for (let p = 0; p < PUSHES; p++) {
      const { drawables, pointCenters } = renderLayer(scene, "pts");
      expect(drawables).toBe(first.drawables); // same array instance
      expect(pointCenters).toBe(first.pointCenters); // buffers() retains its interleaved array too
      for (const d of drawables) seen.add(d);
    }
    // THE signature: one DrawableVector per drawable in total, not one per drawable per push.
    expect(seen.size).toBe(n);
    expect(first.drawables.length).toBe(n);

    // Non-vacuity 1: an append changes the drawable set, so the view must be replaced.
    scene.appendToGroup("pts", (g) => { g.point(n, 1, 1, 2); });
    const afterAppend = renderLayer(scene, "pts");
    expect(afterAppend.drawables).not.toBe(first.drawables);
    expect(afterAppend.pointCenters).not.toBe(first.pointCenters);
    expect(afterAppend.drawables.length).toBe(n + 1);

    // Non-vacuity 2: a group rebuild likewise.
    scene.group("pts", (g) => { g.point(0, 0, 0, 2); });
    expect(renderLayer(scene, "pts").drawables).not.toBe(afterAppend.drawables);
  });

  it(`push budget: ${PUSHES} unchanged pushes over ${N.toLocaleString()} drawables stay O(1)`, () => {
    const scene = pointScene(N);
    renderLayer(scene, "pts"); // the one materialization a data change is allowed

    const t0 = performance.now();
    for (let p = 0; p < PUSHES; p++) renderLayer(scene, "pts");
    const total = performance.now() - t0;

    // Measured on this branch: 0.04 ms for the whole loop. With the pre-fix per-call
    // materialization the same loop takes 31,385 ms (≈1.57 s per push — worse than the 0.16
    // µs/drawable measured at 200k, because 3M short-lived objects per push drag GC in too).
    expect(total).toBeLessThan(200); // ms for ALL 20 pushes
  }, 300_000);

  it(`push budget: a push after a declutter flags write resyncs in place (${N.toLocaleString()} drawables)`, () => {
    // The gesture-boundary shape: the per-frame declutter has rewritten every flag byte, so the
    // retained view is out of date and the push must resync it — in place, with no allocation.
    const scene = pointScene(N);
    const { groupOf } = scene.declutterIndex("pts");
    const groups = 1 + groupOf.reduce((m, g) => (g > m ? g : m), -1);
    const visible = new Uint8Array(groups).fill(1);
    renderLayer(scene, "pts");

    const ts: number[] = [];
    for (let p = 0; p < PUSHES; p++) {
      visible[p % groups] = p % 2 === 0 ? 0 : 1; // the cull verdict actually moves between pushes
      scene.writeDeclutterFlags("pts", visible);
      const t0 = performance.now();
      const { drawables } = renderLayer(scene, "pts");
      ts.push(performance.now() - t0);
      expect(drawables.length).toBe(N);
    }
    ts.sort((a, b) => a - b);
    const median = ts[Math.floor(PUSHES / 2)]!;
    // Measured: 9.9 ms per push on this branch (in-place resync, zero allocation) against
    // 1,126 ms pre-fix. 60 ms keeps ~6× headroom over the former and is 19× under the latter.
    expect(median).toBeLessThan(60);
  }, 300_000);
});
