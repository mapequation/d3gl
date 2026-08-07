// Per-frame + memory guard for MULTIPLE pass-through layers (#110).
//
// #110 asked for a framebuffer PER pass-through layer. That was rejected: an offscreen RGBA8
// surface costs width×height×4 bytes (a 1920×1080 layer ≈ 8.3 MB), so N layers would cost N× that
// for a feature no consumer uses at N > 1 — both website streaming examples register exactly one.
// The fix instead keeps ONE shared accumulation surface and makes the CLEAR cycle-scoped: one
// repaint pass walks every pass-through layer, clears once, and appends the rest.
//
// That decision is only worth anything if it is mechanically pinned, so this file asserts the two
// signatures a future "let's just give each layer its own FBO" would break, plus the one a naive
// cycle rewrite would break:
//
//   A. MEMORY — registering the 2nd..4th pass-through layer allocates ZERO extra framebuffers and
//      zero extra textures (a colour attachment is a texture). Non-vacuity: the 1st one allocates.
//   B. PER-FRAME — during a gesture the pass-through path re-rasterizes NOTHING (the backend
//      snapshot-pans the accumulation surface), so a zoom sweep over two layers holding N items
//      runs ZERO datum accessors, whatever N is.
//   C. SETTLE — one settle repaint costs O(total items across all layers), never O(layers × items):
//      the same N split across two layers runs exactly N accessor calls, the same as one layer of N.
//
// A, B and C are all exact counts, so they hold at every N; only the wall-clock ceilings scale.
import { describe, it, expect, afterEach } from "vitest";
import { Plot } from "./plot.js";
import type { ViewTransform } from "../core/index.js";
import { perfHost, zoomSteps, sweepFrames } from "../__tests__/engine-sweep.js";
import { perfBudget, perfN } from "../__tests__/perf-budget.js";

/**
 * Counts GL surface allocations on the shared prototype — the cast-free way to ask "did this
 * allocate another framebuffer?". `GlBufferSpy` (engine-sweep.ts) covers buffers; framebuffers and
 * their colour-attachment textures are the ones that carry the width×height×4 cost #110 is about.
 */
class GlSurfaceSpy {
  framebuffers = 0;
  textures = 0;
  private readonly origFramebuffer: WebGL2RenderingContext["createFramebuffer"];
  private readonly origTexture: WebGL2RenderingContext["createTexture"];

  constructor() {
    const proto = WebGL2RenderingContext.prototype;
    this.origFramebuffer = proto.createFramebuffer;
    this.origTexture = proto.createTexture;
    const spy = this;
    proto.createFramebuffer = function (this: WebGL2RenderingContext): WebGLFramebuffer | null {
      spy.framebuffers++;
      return spy.origFramebuffer.call(this);
    };
    proto.createTexture = function (this: WebGL2RenderingContext): WebGLTexture | null {
      spy.textures++;
      return spy.origTexture.call(this);
    };
  }

  mark(): { framebuffers: number; textures: number } {
    return { framebuffers: this.framebuffers, textures: this.textures };
  }

  since(at: { framebuffers: number; textures: number }): { framebuffers: number; textures: number } {
    return { framebuffers: this.framebuffers - at.framebuffers, textures: this.textures - at.textures };
  }

  /** Always call this (in a `finally`) — the patch is on a shared prototype. */
  restore(): void {
    const proto = WebGL2RenderingContext.prototype;
    proto.createFramebuffer = this.origFramebuffer;
    proto.createTexture = this.origTexture;
  }
}

/** `setInteracting` is protected, `setTransform` public — a subclass reaches both with no cast. */
class PerfPlot extends Plot {
  interact(v: boolean): void {
    this.setInteracting(v);
  }
  applyTransform(t: ViewTransform): void {
    this.setTransform(t);
  }
}

interface Pt {
  x: number;
  y: number;
}

const W = 400;
const H = 400;
/** Items per pass-through layer in the two-layer legs (so `2 * N` in flight). Capped at 50k
 *  because leg C runs SIX full settle repaints of `2 * N` items and each one expands every point
 *  to a 4-vertex quad (~120 B/point) and uploads it — 100k in flight is ~12 MB per repaint, which
 *  is as much as CI's SwiftShader carries inside the per-file budget. Every assertion here is an
 *  exact count, so the guard is equally strict at whatever N the tier picks. */
const N = perfN(25_000, { max: 50_000 });

const makePoints = (n: number, seed: number): Pt[] => {
  const out: Pt[] = new Array<Pt>(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = { x: (s % W), y: ((s >> 8) % H) };
  }
  return out;
};

describe("multiple pass-through layers: memory + per-frame cost (#110)", () => {
  const hosts: HTMLElement[] = [];
  const charts: Plot[] = [];
  afterEach(() => {
    for (const c of charts.splice(0)) c.destroy();
    for (const h of hosts.splice(0)) h.remove();
  });

  const newChart = async (): Promise<PerfPlot> => {
    const host = perfHost(W, H);
    hosts.push(host);
    const chart = new PerfPlot(host, { width: W, height: H, backend: "webgl" });
    charts.push(chart);
    await chart.whenReady();
    return chart;
  };

  it("A: pass-through layers 2..4 allocate ZERO extra framebuffers/textures (one shared surface)", async () => {
    const chart = await newChart();
    const data = makePoints(64, 7);
    const spy = new GlSurfaceSpy();
    try {
      const opts = { x: (d: Pt) => d.x, y: (d: Pt) => d.y, radius: 2, fill: "rgb(255,0,0)", passThrough: true as const };
      const before1 = spy.mark();
      chart.points("pt0", data, opts);
      const first = spy.since(before1);
      // Non-vacuity: the FIRST pass-through layer really does allocate the accumulation surface.
      expect(first.framebuffers).toBeGreaterThanOrEqual(1);

      for (let i = 1; i < 4; i++) {
        const before = spy.mark();
        chart.points(`pt${i}`, data, opts);
        const extra = spy.since(before);
        // The whole #110 decision, in one number: a per-layer FBO would make this 1 (+1 texture),
        // i.e. width×height×4 bytes per layer. The shared surface makes it 0 at every layer count.
        expect(extra.framebuffers).toBe(0);
        expect(extra.textures).toBe(0);
      }
    } finally {
      spy.restore();
    }
  });

  it("B: a zoom gesture over two pass-through layers re-projects NOTHING (snapshot-pan)", async () => {
    const chart = await newChart();
    const a = makePoints(N, 11);
    const b = makePoints(N, 29);
    let calls = 0;
    const opts = {
      x: (d: Pt) => {
        calls++;
        return d.x;
      },
      y: (d: Pt) => d.y,
      radius: 2,
      passThrough: true as const,
    };
    chart.points("a", a, { ...opts, fill: "rgb(255,0,0)" });
    chart.points("b", b, { ...opts, fill: "rgb(0,0,255)" });
    // Registration projected both layers (the shared surface is cleared once per cycle, so
    // declaring `b` repaints `a` too) — 2 * N for `a`'s two cycles plus N for `b`'s one.
    expect(calls).toBe(3 * N);

    const spy = new GlSurfaceSpy();
    try {
      const surfacesBefore = spy.mark();
      chart.interact(true); // gesture start: cancel in-flight fills + snapshot
      const before = calls;
      const { worstFrameMs, frames } = sweepFrames(zoomSteps(W, H), (t) => chart.applyTransform(t));
      const duringGesture = calls - before;
      chart.interact(false); // settle: ONE cycle re-projects both layers, so the gesture's zero
      const onSettle = calls - before - duringGesture; //  is a real skip, not a dead pipeline
      // THE per-frame signature: a gesture frame does not touch the data at all.
      expect(duringGesture).toBe(0);
      expect(onSettle).toBe(2 * N); // non-vacuity + the settle's own O(total) count
      expect(frames).toBeGreaterThan(0);
      // ...and it allocates no surfaces either (a per-layer FBO scheme would resize/realloc here).
      expect(spy.since(surfacesBefore).framebuffers).toBe(0);
      // Wall clock: a gesture frame is a retained re-render plus one full-screen blit — flat in N.
      expect(worstFrameMs).toBeLessThan(perfBudget(20));
    } finally {
      spy.restore();
    }
  });

  it("C: a settle repaint costs O(total items), not O(layers × items)", async () => {
    const chart = await newChart();
    const all = makePoints(2 * N, 31);
    // Callback sources so the SAME two registered layers can hold different splits of one total.
    let split = 2 * N; // items in layer `a`; layer `b` gets the rest
    let calls = 0;
    const opts = {
      x: (d: Pt) => {
        calls++;
        return d.x;
      },
      y: (d: Pt) => d.y,
      radius: 2,
      passThrough: true as const,
    };
    chart.points("a", () => all.slice(0, split), { ...opts, fill: "rgb(255,0,0)" });
    chart.points("b", () => all.slice(split), { ...opts, fill: "rgb(0,0,255)" });

    const settle = (): number => {
      const before = calls;
      const t0 = performance.now();
      chart.applyTransform({ k: 1.5, x: 0, y: 0 }); // programmatic ⇒ not interacting ⇒ full repaint
      const ms = performance.now() - t0;
      expect(calls - before).toBe(2 * N); // every item projected exactly ONCE per settle
      return ms;
    };

    const oneLayerMs = Math.min(settle(), settle(), settle()); // all 2N in `a`, `b` empty
    split = N; // same total, now split across both layers
    const twoLayerMs = Math.min(settle(), settle(), settle());

    // Splitting a fixed total across layers must not multiply the work: the cycle repaints each
    // layer once, so the two runs project the same 2N items. Allow 60% for the extra draw call,
    // the second layer's `slice`, and timer noise — a per-layer full repaint would be ~2×.
    expect(twoLayerMs).toBeLessThan(oneLayerMs * 1.6 + perfBudget(2));
    expect(twoLayerMs).toBeLessThan(perfBudget(160));
  });
});
