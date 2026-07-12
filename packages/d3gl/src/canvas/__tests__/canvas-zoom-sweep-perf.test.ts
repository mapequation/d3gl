import { describe, it, expect, beforeAll } from "vitest";
import { Scene } from "../../core/scene.js";
import type { RenderLayer, ViewTransform } from "../../core/index.js";

/**
 * Per-frame regression guard for the Canvas full-detail zoom sweep (#220, AGENTS.md lifecycle §5).
 *
 * Canvas repaints every visible drawable on each transform change — the per-frame cost is
 * inherently O(visible drawables) — so the guard pins that cost to EXACTLY one pass and nothing
 * more, through the actual trigger the engine fires per zoom frame (`setTransform` + `render`):
 *   1. **Signature — exactly one draw per circle per frame:** `ctx.arc` runs exactly N times per
 *      frame, constant across the sweep (a double-draw or per-frame amplification changes the
 *      count deterministically, at any speed).
 *   2. **Signature — clip built ONCE, not per frame:** the clip silhouette (`Path2D`) for the
 *      clipped layer is constructed once for the whole sweep (`clipCache`); a per-frame re-clip
 *      regression bumps the construction count.
 *   3. **Frame budget:** each frame's backend CPU work stays under a generous wall-clock ceiling,
 *      catching an order-of-magnitude drop without flakiness.
 *
 * The 2D context is a counting mock (the `canvas-append.test.ts` pattern), so this measures the
 * backend's own loop — the seam d3gl owns — not Chromium's rasterizer (that's the browser tier).
 *
 * Reductions are OFF here by design: this is the full-detail draw the core values require to stay
 * efficient at scale. N=100k runs in the normal suite; the ~1M leg is env-gated
 * (BENCH_CANVAS_SWEEP=1, picked up by scripts/run-perf-tier.mjs) with the same signatures.
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
  arcs = 0;
  fills = 0;
  clips = 0;
  beginPaths = 0;
  setTransform(): void {}
  clearRect(): void {}
  save(): void {}
  restore(): void {}
  beginPath(): void { this.beginPaths++; }
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  arc(): void { this.arcs++; }
  rect(): void {}
  clip(): void { this.clips++; }
  fill(): void { this.fills++; }
  stroke(): void {}
  set fillStyle(_v: string) {}
  set strokeStyle(_v: string) {}
  set lineWidth(_v: number) {}
  set lineJoin(_v: string) {}
  set miterLimit(_v: number) {}
  set lineCap(_v: string) {}
}

let CanvasBackend: typeof import("../canvas-backend.js").CanvasBackend;

beforeAll(async () => {
  (globalThis as { Path2D?: unknown }).Path2D = FakePath2D;
  ({ CanvasBackend } = await import("../canvas-backend.js"));
});

const W = 1280;
const H = 800;

function fakeCanvas(ctx: CountingCtx) {
  return { getContext: () => ctx, width: W, height: H } as unknown as HTMLCanvasElement;
}

const layerOf = (s: Scene, name: string, clipTo?: string): RenderLayer => ({
  name, buffers: s.buffers(name), drawables: s.drawables(name), clipTo,
});

/** N batched points clipped to a base polygon — the full-detail geo/plot layer shape. */
function buildScene(n: number): Scene {
  const scene = new Scene();
  scene.group("land", (b) => b.drawable("L", (c) => c.rect(0, 0, 1000, 1000)));
  scene.setFill("land", "L", "rgb(0,128,0)");
  const centers: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) centers[i] = [i % 1000, Math.floor(i / 1000) % 1000];
  scene.group("pts", (g) => g.points("all", centers, 2));
  scene.setFill("pts", "all", "rgb(200,60,40)");
  return scene;
}

/** Drive the real per-zoom trigger (setTransform + render) across a zoom-in sweep. */
function zoomSweep(n: number): { worstMs: number; arcsPerFrame: number[]; path2dBuilt: number; frames: number } {
  const scene = buildScene(n);
  const ctx = new CountingCtx();
  const backend = new CanvasBackend(fakeCanvas(ctx), W, H);
  backend.setLayers([layerOf(scene, "land"), layerOf(scene, "pts", "land")]);
  backend.setTransform({ k: 1, x: 0, y: 0 });
  backend.render(); // initial paint (builds + caches the clip)
  const p2dAfterFirst = FakePath2D.constructed;

  const sweep: ViewTransform[] = [1, 2, 4, 8, 16, 32].map((m) => ({ k: m, x: (W / 2) * (1 - m), y: (H / 2) * (1 - m) }));
  const arcsPerFrame: number[] = [];
  let worstMs = 0;
  for (const t of sweep) {
    // Warm + timed: min of a few reps sheds scheduler noise (selection-dim-perf pattern).
    let best = Infinity;
    let arcs = 0;
    for (let rep = 0; rep < 3; rep++) {
      const a0 = ctx.arcs;
      const t0 = performance.now();
      backend.setTransform(t);
      backend.render();
      best = Math.min(best, performance.now() - t0);
      arcs = ctx.arcs - a0;
    }
    arcsPerFrame.push(arcs);
    worstMs = Math.max(worstMs, best);
  }
  return { worstMs, arcsPerFrame, path2dBuilt: FakePath2D.constructed - p2dAfterFirst, frames: sweep.length };
}

describe("Canvas full-detail zoom sweep (per-frame cost pinned)", () => {
  it("draws each circle exactly once per frame, reuses the clip, and holds the frame budget at 100k", () => {
    const N = 100_000;
    const r = zoomSweep(N);
    // Signature 1: exactly one arc per circle per frame — no double-draw, no amplification.
    for (const arcs of r.arcsPerFrame) expect(arcs).toBe(N);
    // Signature 2: the clip silhouette is NOT rebuilt per frame (clipCache holds across transforms).
    expect(r.path2dBuilt).toBe(0);
    // Frame budget: generous ceiling (~10× local, ~3× shared-runner headroom) for the 100k loop.
    expect(r.worstMs).toBeLessThan(400);
  });

  it.runIf(process.env.BENCH_CANVAS_SWEEP)(
    "at-scale leg: same signatures at ~1M (env-gated; run by the CI perf tier)",
    () => {
      const N = Number(process.env.BENCH_CANVAS_SWEEP_N) || 1_000_000;
      const ceiling = Number(process.env.PERF_CANVAS_FRAME_MS) || 2000;
      const r = zoomSweep(N);
      for (const arcs of r.arcsPerFrame) expect(arcs).toBe(N);
      expect(r.path2dBuilt).toBe(0);
      console.log(`canvas sweep N=${N.toLocaleString()}: worst frame ${r.worstMs.toFixed(1)}ms (ceiling ${ceiling}ms)`);
      expect(r.worstMs).toBeLessThan(ceiling);
    },
    120_000,
  );
});
