import { describe, it, expect, beforeAll, vi } from "vitest";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost, sweepFrames, zoomSteps } from "../../__tests__/engine-sweep.js";

// Count the retained Scene's glyph emits: every rebuild of the network Scene emits its nodes once, through
// `emitNodes` (LOD off) or `traceFrontierGlyphs` (the LOD frontier). A typed probe of the real scene work.
const emits = vi.hoisted(() => ({ n: 0 }));
vi.mock("../glyphs.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../glyphs.js")>();
  return {
    ...mod,
    emitNodes: (...args: Parameters<typeof mod.emitNodes>) => {
      emits.n++;
      return mod.emitNodes(...args);
    },
    traceFrontierGlyphs: (...args: Parameters<typeof mod.traceFrontierGlyphs>) => {
      emits.n++;
      return mod.traceFrontierGlyphs(...args);
    },
  };
});

/**
 * ENGINE-level per-frame guard for a programmatic `setTransform` on a **Canvas / SVG** network with zoom
 * enabled (#309, AGENTS.md lifecycle §5).
 *
 * A retained backend cannot re-cut per frame, so a programmatic view change settles like a gesture's end:
 * `afterProgrammaticTransform` → `syncScreenGeometry` → one Scene rebuild, O(drawn nodes + edges) — every
 * node and edge with LOD off, the frontier and its super-edges with LOD on. Before #309 the same rebuild ran
 * as the end of a fake d3-zoom gesture, so the cost per call is unchanged; this pins it where it now lives.
 * A consumer that animates the camera with `setTransform` while zoom is enabled pays it on every frame.
 *
 * The trigger is the real one, a `setTransform` zoom sweep on the public engine, in both reduction states.
 * Signatures (deterministic): each call runs exactly one re-cut (`syncScreenGeometry`) and exactly one
 * Scene rebuild's glyph emit, never a gesture boundary (`setInteracting`). Budget: the worst step, split
 * into a constant and a linear term.
 *
 * Scale: Canvas at `perfN(20k, max 100k)`, SVG at `perfN(10k, max 30k)`. Not ≈1M: a retained backend
 * rebuilds one Scene entry per drawn node and edge per call (and SVG one DOM node each), so ≈1M is not a
 * supported per-frame regime on either — that scale belongs to the WebGL lane, which re-cuts live and never
 * gets here (`network-sweep-perf`). What this guard catches is a second rebuild per call, or a rebuild
 * that stops scaling with the drawn set.
 */

// MEASURED (local headless Chromium, load average ~11-15; worst step, fastest of 3 reps; the same on
// `main`'s engine source, where the re-cut ran as the fake gesture's end):
//   canvas  20k: LOD off 198-206 ms with zoom (18 ms without), LOD on 45-52 ms (0 ms without)
//   canvas 100k: LOD off 1130 ms (104 ms without),             LOD on 56 ms
//   svg     10k: LOD off 280-299 ms (30 ms without),           LOD on 73-120 ms
//   svg     30k: LOD off 943 ms (94 ms without),               LOD on 90 ms
// LOD off grows with every drawn node and edge; LOD on stays near-flat in N (the frontier is screen-bounded).
const W = 640;
const H = 400;
const SETUP_MS = perfBudget(120_000);

/** Counts the re-cut and gesture hooks without reaching into privates. */
class VectorProbe extends Network {
  syncs = 0;
  boundaries = 0;
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  override syncScreenGeometry(): this {
    this.syncs++;
    return super.syncScreenGeometry();
  }
  protected override setInteracting(v: boolean): void {
    this.boundaries++;
    super.setInteracting(v);
  }
}

/** A binary-tree graph on a square grid (network-sweep-perf's fixture): a real hierarchy for LOD. */
function fixture(n: number): { graph: NetworkGraph; positions: Float32Array } {
  const cols = Math.max(1, Math.round(Math.sqrt(n)));
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = (i % cols) * 8;
    positions[i * 2 + 1] = Math.floor(i / cols) * 8;
  }
  const source = new Int32Array(n - 1);
  const target = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) {
    source[i - 1] = i;
    target[i - 1] = Math.floor(i / 2);
  }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), positions };
}

interface Sweep {
  frames: number;
  worstFrameMs: number;
  syncs: number;
  boundaries: number;
  emits: number;
}

interface Leg {
  /** The sweep with zoom enabled: each call re-cuts. */
  zoom: Sweep;
  /** The same sweep with zoom disabled: the caller re-cuts, so a call only redraws (the baseline). */
  free: Sweep;
  /** Glyph emits of one forced rebuild (the per-call unit). */
  emitsPerRebuild: number;
}

const BACKENDS = [
  { backend: "canvas", n: perfN(20_000, { max: 100_000 }) },
  { backend: "svg", n: perfN(10_000, { max: 30_000 }) },
] as const;

const results = new Map<string, { off: Leg; on: Leg }>();

beforeAll(async () => {
  for (const { backend, n } of BACKENDS) {
    const net = new VectorProbe(perfHost(W, H), { width: W, height: H, backend });
    await net.whenReady();
    const { graph, positions } = fixture(n);
    net.data(graph).style({ nodeRadius: 3, sizeMode: "screen" }).layout({ backend: "positions", positions });

    const sweep = (): Sweep => {
      const s0 = net.syncs;
      const b0 = net.boundaries;
      const e0 = emits.n;
      const { worstFrameMs, frames } = sweepFrames(zoomSteps(W, H), (t) => net.setTransform(t));
      return { frames, worstFrameMs, syncs: net.syncs - s0, boundaries: net.boundaries - b0, emits: emits.n - e0 };
    };
    const leg = (): Leg => {
      const e0 = emits.n;
      net.syncScreenGeometry();
      const emitsPerRebuild = emits.n - e0;
      net.disableInteraction();
      const free = sweep();
      net.enableZoom([1e-3, 1e3]);
      const zoom = sweep();
      return { zoom, free, emitsPerRebuild };
    };

    const off = leg();
    net.lod({ declutter: true, maxAggregateRadius: 24 });
    const on = leg();
    results.set(backend, { off, on });
    net.destroy();
  }
}, SETUP_MS);

describe("network() Canvas/SVG programmatic zoom sweep, zoom enabled (#309)", () => {
  for (const { backend, n } of BACKENDS) {
    // Ceilings ~4-8× the measured worst step, split into constant + linear terms (see MEASURED).
    const ceiling = {
      off: perfBudget(backend === "canvas" ? 100 + (900 * n) / 20_000 : 100 + (1400 * n) / 10_000),
      on: perfBudget(backend === "canvas" ? 200 + (25 * n) / 20_000 : 300 + (50 * n) / 10_000),
    };
    for (const lod of ["off", "on"] as const) {
      it(`${backend}, LOD ${lod} (N=${n.toLocaleString()}): one re-cut and one Scene rebuild per setTransform, no gesture`, () => {
        const r = results.get(backend)?.[lod];
        if (!r) throw new Error("the sweep did not run");
        expect(r.emitsPerRebuild, "non-vacuity: a rebuild emitted no glyphs").toBeGreaterThan(0);
        expect(r.zoom.syncs, "re-cuts per programmatic setTransform").toBe(r.zoom.frames);
        expect(r.zoom.emits, "Scene rebuilds per programmatic setTransform").toBe(r.zoom.frames * r.emitsPerRebuild);
        expect(r.zoom.boundaries, "a programmatic setTransform ran a gesture boundary").toBe(0);
        // Without zoom the caller re-cuts (the documented contract): a call rebuilds nothing.
        expect(r.free.syncs, "a zoom-free setTransform re-cut on its own").toBe(0);
        expect(r.free.emits, "a zoom-free setTransform rebuilt the Scene").toBe(0);
        const msg = `${backend} LOD ${lod}: worst step ${r.zoom.worstFrameMs.toFixed(1)} ms with zoom, ${r.free.worstFrameMs.toFixed(1)} ms without`;
        expect(r.zoom.worstFrameMs, msg).toBeLessThan(ceiling[lod]);
      });
    }
  }
});
