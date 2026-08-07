import { describe, it, expect } from "vitest";
import { plot } from "./plot.js";
import { perfBudget, perfN } from "../__tests__/perf-budget.js";

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
// One shared fixture size for both tests; the browser tier raises it via PERF_BROWSER_N (#262).
// Everything on the measured path is linear in N — and note `declutterScreen` deliberately KEEPS
// off-screen centres (core/declutter.ts), so `kept ≈ N` at scale rather than being viewport-bounded.
// That is what makes this a real at-scale guard and also why the ceilings below are linear in N.
const N = perfN(5000);
const COLS = Math.max(1, Math.round(Math.sqrt(N))); // keep the cloud square as N grows
const FRAMES_A = 12;
const FRAMES_B = 8;
// c0 (engine + submit, N-independent) + c1*N (select, gather, upload, draw — all O(N)).
// Reduces to the historical shape at the local default; grows honestly with a tier N.
const FRAME_MS = perfBudget(8 + N / 4_000);
// Registration is O(N) on top of FRAMES × O(N), so the harness timeout must scale too — otherwise a
// scaled run dies on a timeout instead of reporting its budget. A timeout is a harness limit, not a
// budget (AGENTS.md §Tests).
const TEST_MS = perfBudget(20_000 + N / 20);

function host(w = 480, h = 320): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  document.body.appendChild(el);
  return el;
}

describe("plot.points() declutter lane — per-frame cost (#108-C regression guard)", () => {
  it("resolves each point's x/y/radius/fill at most ONCE over a whole zoom sweep, never per frame", async () => {
    // A grid so declutter keeps a large fraction (the expensive case): kept stays O(N), not O(1).
    const data = Array.from({ length: N }, (_, i) => ({ x: (i % COLS) * 6, y: Math.floor(i / COLS) * 6, c: i }));
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

    // Each point's geometry/colour resolved AT MOST ONCE for the whole session (not kept×frames).
    // Pre-fix this was ~kept × (1 + 12) ≫ N; the fix resolves the full SoA once and reuses it.
    expect(xCalls).toBeLessThanOrEqual(N);
    expect(yCalls).toBeLessThanOrEqual(N);
    expect(rCalls).toBeLessThanOrEqual(N);
    expect(fillCalls).toBeLessThanOrEqual(N);
    // Sanity: it really did resolve (rendered), not vacuously zero.
    expect(fillCalls).toBeGreaterThan(0);

    // A zoom-in sweep. World positions/radii/colours are fixed; only the transform changes (applied by
    // the GPU matrix). The per-frame cut/declutter+draw must NOT re-derive them.
    // FRAMES is NOT a scale knob — scaling it as well would make the cost quadratic.
    const before = { x: xCalls, y: yCalls, r: rCalls, f: fillCalls };
    const t0 = performance.now();
    for (let k = 0; k < FRAMES_A; k++) chart.setTransform({ k: 1 + k * 0.7, x: -k * 12, y: -k * 9 });
    const perFrame = (performance.now() - t0) / FRAMES_A;

    // The N-INVARIANT form of the signature: ZERO accessor calls during the sweep. Unlike the
    // `<= N` bounds above it cannot go vacuous when the fixture's on-screen fraction changes with N.
    expect(xCalls, "x accessor re-ran during the zoom sweep").toBe(before.x);
    expect(yCalls, "y accessor re-ran during the zoom sweep").toBe(before.y);
    expect(rCalls, "radius accessor re-ran during the zoom sweep").toBe(before.r);
    expect(fillCalls, "fill accessor re-ran during the zoom sweep").toBe(before.f);
    // The at-scale leg needs a wall-clock leg too, else it reports nothing but the tier's 300s kill.
    expect(perFrame, `${perFrame.toFixed(1)}ms/frame at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS);
    chart.destroy();
  }, TEST_MS);

  it("updates the GPU instance buffer in place on setTransform — does not destroy+recreate it per frame", async () => {
    const data = Array.from({ length: N }, (_, i) => ({ x: (i % COLS) * 6, y: Math.floor(i / COLS) * 6 }));
    const chart = plot(host(), { width: 480, height: 320, backend: "webgl" });
    await chart.whenReady();
    chart.points("pts", data, { x: (d) => d.x, y: (d) => d.y, radius: 3, fill: "#3b82f6", sizeMode: "screen", declutter: 8, pickable: false });

    // Reach into the WebGL backend's instanced-layer registry. The object backing "points:pts" must be
    // the SAME instance across zoom frames — i.e. updated in place, not destroyed+recreated each frame.
    const instanced = (chart as unknown as { handle: { backend: { instanced: Map<string, object> } } }).handle.backend.instanced;
    const before = instanced.get("points:pts");
    expect(before).toBeDefined();
    for (let k = 0; k < FRAMES_B; k++) chart.setTransform({ k: 1 + k * 0.8, x: -k * 15, y: -k * 11 });
    const after = instanced.get("points:pts");
    expect(after).toBe(before); // same object reference ⇒ no per-frame teardown/recreate
    chart.destroy();
  }, TEST_MS);
});
