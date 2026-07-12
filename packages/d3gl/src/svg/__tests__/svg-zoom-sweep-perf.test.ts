import { describe, it, expect, beforeAll } from "vitest";
import { Scene } from "../../core/scene.js";
import type { RenderLayer, ViewTransform } from "../../core/index.js";

/**
 * Per-frame regression guard for the SVG at-scale zoom sweep (#220, AGENTS.md lifecycle §5).
 *
 * SvgBackend's contract for all-world content is a **retained DOM**: the drawables are
 * serialized ONCE into the view group, and every subsequent pan/zoom is O(1) — one `transform`
 * attribute set, with the follow-up `render()` a no-op (`dirty` stays false). A regression that
 * re-serializes N drawables per zoom frame (the exact class AGENTS §5 war-stories) is
 * deterministically visible as extra `innerHTML` assignments, at any machine speed.
 *
 * Through the actual per-zoom trigger (`setTransform` + `render`), this asserts:
 *   1. **Signature — serialize once:** the view group's `innerHTML` is assigned exactly once
 *      (the initial render); a zoom sweep adds ZERO re-serializations.
 *   2. **Signature — O(1) transform:** each sweep step sets the view `transform` attribute once.
 *   3. **Budgets:** the one-time serialize of N drawables and the per-frame O(1) step each hold
 *      a generous wall-clock ceiling.
 *
 * The DOM is a counting fake (SvgBackend only needs createElementNS / setAttribute / innerHTML /
 * append), so this runs in the node suite. N=100k in the normal suite; the ~1M leg is env-gated
 * (BENCH_SVG_SWEEP=1, picked up by scripts/run-perf-tier.mjs) with the same signatures.
 */
class FakeEl {
  attrSets = new Map<string, number>();
  innerHTMLSets = 0;
  private html = "";
  private kids: FakeEl[] = [];
  setAttribute(name: string, _value: string): void {
    this.attrSets.set(name, (this.attrSets.get(name) ?? 0) + 1);
  }
  append(...els: FakeEl[]): void { this.kids.push(...els); }
  appendChild(el: FakeEl): FakeEl { this.kids.push(el); return el; }
  remove(): void {}
  set innerHTML(v: string) { this.innerHTMLSets++; this.html = v; }
  get innerHTML(): string { return this.html; }
  get children(): readonly FakeEl[] { return this.kids; }
}

let SvgBackend: typeof import("../svg-backend.js").SvgBackend;
const created: FakeEl[] = [];

beforeAll(async () => {
  (globalThis as { document?: unknown }).document = {
    createElementNS: (): FakeEl => { const el = new FakeEl(); created.push(el); return el; },
  };
  ({ SvgBackend } = await import("../svg-backend.js"));
});

const W = 1280;
const H = 800;

const layerOf = (s: Scene, name: string): RenderLayer => ({ name, buffers: s.buffers(name), drawables: s.drawables(name) });

/** N batched world-mode points — the retained full-detail layer shape. */
function buildScene(n: number): Scene {
  const scene = new Scene();
  const centers: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) centers[i] = [i % 1000, Math.floor(i / 1000) % 1000];
  scene.group("pts", (g) => g.points("all", centers, 2));
  scene.setFill("pts", "all", "rgb(200,60,40)");
  return scene;
}

function zoomSweep(n: number): { serializeMs: number; worstFrameMs: number; viewHtmlSets: number; viewTransformSets: number; frames: number } {
  const scene = buildScene(n);
  const host = new FakeEl() as unknown as HTMLElement;
  created.length = 0;
  const backend = new SvgBackend(host, W, H);
  // The constructor creates root/defs/view/screen/text; find the view group as the element
  // whose transform attribute a setTransform touches (robust to construction-order changes).
  backend.setLayers([layerOf(scene, "pts")]);
  backend.setTransform({ k: 1, x: 0, y: 0 });
  const view = created.find((el) => (el.attrSets.get("transform") ?? 0) > 0);
  if (!view) throw new Error("could not locate the view group");
  const t0 = performance.now();
  backend.render(); // the ONE serialize of all N drawables
  const serializeMs = performance.now() - t0;

  const baseHtmlSets = view.innerHTMLSets;
  const baseTransformSets = view.attrSets.get("transform") ?? 0;
  const sweep: ViewTransform[] = [2, 4, 8, 16, 32, 64].map((m) => ({ k: m, x: (W / 2) * (1 - m), y: (H / 2) * (1 - m) }));
  let worstFrameMs = 0;
  for (const t of sweep) {
    const f0 = performance.now();
    backend.setTransform(t);
    backend.render(); // must no-op: only the transform changed
    worstFrameMs = Math.max(worstFrameMs, performance.now() - f0);
  }
  return {
    serializeMs,
    worstFrameMs,
    viewHtmlSets: view.innerHTMLSets - baseHtmlSets,
    viewTransformSets: (view.attrSets.get("transform") ?? 0) - baseTransformSets,
    frames: sweep.length,
  };
}

describe("SVG at-scale zoom sweep (retained DOM, O(1) per frame)", () => {
  it("serializes 100k drawables once — a zoom sweep re-serializes NOTHING and stays O(1)/frame", () => {
    const r = zoomSweep(100_000);
    // Signature 1: zero re-serializations across the sweep (the retained DOM stands).
    expect(r.viewHtmlSets).toBe(0);
    // Signature 2: exactly one transform-attribute set per sweep step (render() no-ops).
    expect(r.viewTransformSets).toBe(r.frames);
    // Budgets: one-time serialize bounded; the O(1) frame step is orders below any redraw.
    expect(r.serializeMs).toBeLessThan(3000);
    expect(r.worstFrameMs).toBeLessThan(50);
  });

  it.runIf(process.env.BENCH_SVG_SWEEP)(
    "at-scale leg: same signatures at ~1M (env-gated; run by the CI perf tier)",
    () => {
      const N = Number(process.env.BENCH_SVG_SWEEP_N) || 1_000_000;
      const serializeCeiling = Number(process.env.PERF_SVG_SERIALIZE_MS) || 30_000;
      const r = zoomSweep(N);
      expect(r.viewHtmlSets).toBe(0);
      expect(r.viewTransformSets).toBe(r.frames);
      console.log(`svg sweep N=${N.toLocaleString()}: serialize ${r.serializeMs.toFixed(0)}ms (ceiling ${serializeCeiling}ms), worst frame ${r.worstFrameMs.toFixed(2)}ms`);
      expect(r.serializeMs).toBeLessThan(serializeCeiling);
      expect(r.worstFrameMs).toBeLessThan(50);
    },
    120_000,
  );
});
