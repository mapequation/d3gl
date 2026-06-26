import { describe, it, expect } from "vitest";
import { plot } from "./plot.js";

/**
 * Per-frame cost guard for the `plot.points()` declutter instanced lane (#108-C).
 *
 * The regression these pin: routing declutter to the instanced lane originally REBUILT the geometry
 * every `setTransform` — re-running the x/y/radius/fill accessors (parsing every colour string) per
 * kept point per frame, reallocating typed arrays, and destroying+recreating the GPU buffers. On a
 * ~1M-point zoom that dropped to ~2fps, while the retained-Scene path (which resolves geometry ONCE
 * and only flips visibility flags per frame) stayed smooth. Per the perf doctrine, work the baseline
 * did once must not become per-frame. Headless WebGL timing is too lenient to catch FPS drops
 * reliably, so we assert the regression's deterministic signatures directly.
 */
function host(w = 480, h = 320): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  document.body.appendChild(el);
  return el;
}

describe("plot.points() declutter lane — per-frame cost (#108-C regression guard)", () => {
  it("resolves each point's x/y/radius/fill at most ONCE over a whole zoom sweep, never per frame", async () => {
    const N = 5000;
    // A grid so declutter keeps a large fraction (the expensive case): kept stays O(N), not O(1).
    const data = Array.from({ length: N }, (_, i) => ({ x: (i % 100) * 6, y: Math.floor(i / 100) * 6, c: i }));
    let xCalls = 0, yCalls = 0, rCalls = 0, fillCalls = 0;

    const chart = plot(host(), { width: 480, height: 320, backend: "webgl" });
    await chart.whenReady();
    chart.points("pts", data, {
      x: (d) => { xCalls++; return d.x; },
      y: (d) => { yCalls++; return d.y; },
      radius: (_d) => { rCalls++; return 3; },
      fill: (d) => { fillCalls++; return d.c % 2 ? "#ff0000" : "#0000ff"; },
      sizeMode: "screen",
      declutter: 8,
      pickable: false,
    });
    // The lane must register (the layer is lane-eligible: declutter + WebGL + no clipTo/hover/selection).
    expect((chart as unknown as { instancedLanes: Map<string, unknown> }).instancedLanes.has("points:pts")).toBe(true);

    // A zoom-in sweep. World positions/radii/colours are fixed; only the transform changes (applied by
    // the GPU matrix). The per-frame cut/declutter+draw must NOT re-derive them.
    for (let k = 0; k < 12; k++) chart.setTransform({ k: 1 + k * 0.7, x: -k * 12, y: -k * 9 });

    // Each point's geometry/colour resolved AT MOST ONCE for the whole session (not kept×frames).
    // Pre-fix this was ~kept × (1 + 12) ≫ N; the fix resolves the full SoA once and reuses it.
    expect(xCalls).toBeLessThanOrEqual(N);
    expect(yCalls).toBeLessThanOrEqual(N);
    expect(rCalls).toBeLessThanOrEqual(N);
    expect(fillCalls).toBeLessThanOrEqual(N);
    // Sanity: it really did resolve (rendered), not vacuously zero.
    expect(fillCalls).toBeGreaterThan(0);
    chart.destroy();
  });

  it("updates the GPU instance buffer in place on setTransform — does not destroy+recreate it per frame", async () => {
    const N = 4000;
    const data = Array.from({ length: N }, (_, i) => ({ x: (i % 80) * 6, y: Math.floor(i / 80) * 6 }));
    const chart = plot(host(), { width: 480, height: 320, backend: "webgl" });
    await chart.whenReady();
    chart.points("pts", data, { x: (d) => d.x, y: (d) => d.y, radius: 3, fill: "#3b82f6", sizeMode: "screen", declutter: 8, pickable: false });

    // Reach into the WebGL backend's instanced-layer registry. The object backing "points:pts" must be
    // the SAME instance across zoom frames — i.e. updated in place, not destroyed+recreated each frame.
    const instanced = (chart as unknown as { handle: { backend: { instanced: Map<string, object> } } }).handle.backend.instanced;
    const before = instanced.get("points:pts");
    expect(before).toBeDefined();
    for (let k = 0; k < 8; k++) chart.setTransform({ k: 1 + k * 0.8, x: -k * 15, y: -k * 11 });
    const after = instanced.get("points:pts");
    expect(after).toBe(before); // same object reference ⇒ no per-frame teardown/recreate
    chart.destroy();
  });
});
