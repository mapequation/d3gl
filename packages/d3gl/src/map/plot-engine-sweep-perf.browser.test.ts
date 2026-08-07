import { describe, it, expect, beforeAll } from "vitest";
import { plot } from "./plot.js";
import { perfBudget, perfN } from "../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames, zoomSteps } from "../__tests__/engine-sweep.js";

/**
 * ENGINE-level at-scale zoom sweep for `plot()`'s **retained-Scene** path (#263, gap 2 of #258).
 *
 * The two guards this sits between each cover a different half, and both halves left this one out:
 *   - `canvas-`/`svg-zoom-sweep-perf.test.ts` drive the *backend* seam at 100k — a hand-built Scene
 *     pushed straight into `CanvasBackend`/`SvgBackend`. They never run `plot()`.
 *   - `plot-points-perf.browser.test.ts` drives the *engine* at scale, but only along the
 *     `declutter` + WebGL **instanced-lane** branch of `syncPointsLayer`.
 * Neither touches the branch a plain `plot().points(...)` / `plot().layer(...)` takes: geometry
 * resolved once into a retained Scene, then only the transform changes. That branch owns the
 * accessor pass, the `draw`-callback tessellation, and the Scene's GPU upload — all above the
 * backend seam, and all only exercised at N ≤ a few thousand before this.
 *
 * Signatures pinned (deterministic first; the wall-clock ceiling is the order-of-magnitude backstop):
 *   1. **`x` / `y` / `radius` / `fill` / `stroke` / `lineWidth` resolve O(data) at registration and
 *      ZERO per frame** — the N-invariant `toBe(before)` form, so it cannot go vacuous as the
 *      on-screen fraction shifts with N.
 *   2. **The `draw` callback runs once per datum, ever.** Re-tessellating a retained Scene per frame
 *      is the classic way to make a `layer()` zoom O(data) per frame; `draw` counts that exactly,
 *      and unlike a timing check it fires at any speed.
 *   3. **GPU buffers are updated in place, not destroyed + recreated — and nothing is re-uploaded
 *      into them.** Both counted on the live `WebGL2RenderingContext`, with non-vacuity checks that
 *      registration DID create buffers and DID upload. The two catch different regressions:
 *      re-pushing the same arrays into the same buffer every frame moves no create/delete count.
 *
 * ONE ENGINE, BOTH LAYERS, ONE SWEEP — deliberate. Constructing a second WebGL engine after a first
 * has uploaded a six-figure retained Scene costs seconds in `whenReady()` on headless Chromium (see
 * the note in `network-sweep-perf.browser.test.ts` and #287, where it measured 9-12s), which is not this
 * guard's subject. Registering both layers on one chart is also the more realistic scene, and the
 * per-layer accessor counters stay independent.
 */

// Local default keeps the always-on run cheap; the browser tier raises it via PERF_BROWSER_N (#262).
// `max`: this fixture materialises TWO retained layers of N drawables each — N circles plus N
// tessellated rects — with a JS record and a `GrowTexture` style row apiece, so the wall here is
// memory and build time rather than the 2.1M texture-row limit. 300k is ~3x the CI N and already
// ~1.5s of build once the SwiftShader budget scale is applied.
const N = perfN(50_000, { max: 300_000 });
const COLS = Math.max(1, Math.round(Math.sqrt(N))); // keep the cloud square as N grows
const W = 640;
const H = 400;
// Measured worst frame (best-of-3 per step, local headless Chromium) for the two layers together:
// 0.10ms at 50k and 0.10ms at 100k — Chromium's 100µs `performance.now()` quantum, because a
// retained-Scene zoom frame is a uniform write plus the indexed draws. c0 is that N-independent
// dispatch, c1 the backend's small per-frame scan. The ceiling is ~60x the measured value on
// purpose: it is the order-of-magnitude backstop behind the deterministic signatures. The
// regressions it backstops — re-running the accessors or re-tessellating `draw` per frame — cost
// ~200ms+ at 50k, so the detection margin stays >20x at every N.
const FRAME_MS = perfBudget(6 + (6 * N) / 50_000);
// Registration is the O(N) phase; a timeout is a harness limit, not a budget (AGENTS.md §Tests).
const SETUP_MS = perfBudget(120_000 + N / 2);

interface Point {
  x: number;
  y: number;
  i: number;
}
const makePoints = (n: number): Point[] =>
  Array.from({ length: n }, (_, i) => ({ x: (i % COLS) * 6, y: Math.floor(i / COLS) * 6, i }));

/** Accessor-call counters for one layer, sampled before and after the sweep. */
interface Counts {
  [accessor: string]: number;
}

let pointsBefore: Counts;
let pointsAfter: Counts;
let layerBefore: Counts;
let layerAfter: Counts;
let registrationBuffersCreated = 0;
let registrationUploadedBytes = 0;
let sweepBuffersCreated = 0;
let sweepBuffersDeleted = 0;
let sweepUploadedBytes = 0;
let worstFrameMs = 0;
let buildMs = 0;

beforeAll(async () => {
  const spy = new GlBufferSpy();
  try {
    const data = makePoints(N);
    const points: Counts = { x: 0, y: 0, radius: 0, fill: 0 };
    const layer: Counts = { draw: 0, stroke: 0, lineWidth: 0 };

    const chart = plot(perfHost(W, H), { width: W, height: H, backend: "webgl" });
    await chart.whenReady();

    const atStart = spy.mark();
    const buildStart = performance.now();
    chart.points("pts", data, {
      x: (d) => {
        points.x++;
        return d.x;
      },
      y: (d) => {
        points.y++;
        return d.y;
      },
      radius: (_d) => {
        points.radius++;
        return 2;
      },
      fill: (d) => {
        points.fill++;
        return d.i % 2 ? "rgb(239,68,68)" : "rgb(59,130,246)";
      },
      pickable: false, // a hit index is a registration-time cost, orthogonal to the per-frame path
    });
    chart.layer("boxes", data, {
      draw: (ctx, d) => {
        layer.draw++;
        ctx.rect(d.x + 1, d.y + 1, 3, 3);
      },
      fill: "rgb(34,197,94)",
      stroke: (d) => {
        layer.stroke++;
        return d.i % 2 ? "rgb(21,128,61)" : "rgb(6,95,70)";
      },
      lineWidth: (_d) => {
        layer.lineWidth++;
        return 0.5;
      },
      pickable: false,
    });
    buildMs = performance.now() - buildStart;
    const registration = spy.since(atStart);
    registrationBuffersCreated = registration.created;
    registrationUploadedBytes = registration.uploadedBytes;

    pointsBefore = { ...points };
    layerBefore = { ...layer };
    const beforeSweep = spy.mark();
    ({ worstFrameMs } = sweepFrames(zoomSteps(W, H), (t) => chart.setTransform(t)));
    const buffers = spy.since(beforeSweep);
    sweepBuffersCreated = buffers.created;
    sweepBuffersDeleted = buffers.deleted;
    sweepUploadedBytes = buffers.uploadedBytes;
    pointsAfter = { ...points };
    layerAfter = { ...layer };

    chart.destroy();
  } finally {
    spy.restore();
  }
}, SETUP_MS);

describe(`plot() retained-Scene engine zoom sweep — per-frame cost at N=${N.toLocaleString()} x2 layers (#263)`, () => {
  it("registers every accessor exactly once per datum and really owns GPU buffers (non-vacuity)", () => {
    // Without this the zeros below could mean "the fixture never built" instead of "nothing re-ran".
    // `points()` with no `declutter` is NOT lane-eligible, so this is the retained-Scene branch.
    for (const [name, calls] of Object.entries(pointsBefore)) {
      expect(calls, `points() ${name} accessor did not run once per datum at registration`).toBe(N);
    }
    for (const [name, calls] of Object.entries(layerBefore)) {
      expect(calls, `layer() ${name} callback did not run once per datum at registration`).toBe(N);
    }
    expect(
      registrationBuffersCreated,
      "registration created no GPU buffer — the spy is not observing the live context",
    ).toBeGreaterThan(0);
    expect(
      registrationUploadedBytes,
      "registration uploaded no geometry — the spy is not observing the live context",
    ).toBeGreaterThan(0);
  });

  it("points(): resolves x/y/radius/fill ONCE at registration and never re-derives per frame", () => {
    for (const [name, before] of Object.entries(pointsBefore)) {
      expect(pointsAfter[name], `points() ${name} accessor re-ran during the zoom sweep`).toBe(before);
    }
  });

  it("layer(): runs the draw callback ONCE per datum and never re-tessellates per frame", () => {
    // The signature that matters most here: geometry the engine tessellated once must never be
    // re-emitted through the user's draw callback just because the view changed.
    expect(layerAfter.draw, "draw callback re-ran during the zoom sweep — geometry was re-tessellated per frame").toBe(
      layerBefore.draw,
    );
    expect(layerAfter.stroke, "stroke accessor re-ran during the zoom sweep").toBe(layerBefore.stroke);
    expect(layerAfter.lineWidth, "lineWidth accessor re-ran during the zoom sweep").toBe(layerBefore.lineWidth);
  });

  it("updates the GPU buffers in place, re-uploads nothing, and holds the frame budget", () => {
    expect(sweepBuffersCreated, "GPU buffers were created during the zoom sweep").toBe(0);
    expect(sweepBuffersDeleted, "GPU buffers were destroyed during the zoom sweep").toBe(0);
    // Measured: exactly 0 bytes re-uploaded over the whole sweep, against 118MB at registration.
    // Expressed as a ratio rather than `toBe(0)` so a future per-frame UNIFORM write (a few hundred
    // bytes) is not a false positive, while any geometry or style re-upload — the smallest of which
    // is a whole layer, i.e. ~0.5x the registration figure — is 1000x over the line. This is the
    // half of the #186 "render re-emit" regression that a create/delete count alone misses.
    expect(
      sweepUploadedBytes,
      `${sweepUploadedBytes.toLocaleString()} bytes re-uploaded during the zoom sweep (registration uploaded ${registrationUploadedBytes.toLocaleString()})`,
    ).toBeLessThan(registrationUploadedBytes / 1000);
    expect(
      worstFrameMs,
      `worst frame ${worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()} x2 layers (build ${buildMs.toFixed(0)}ms once)`,
    ).toBeLessThan(FRAME_MS);
  });
});
