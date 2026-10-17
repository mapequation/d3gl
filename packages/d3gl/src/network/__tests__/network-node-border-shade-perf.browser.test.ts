import { describe, it, expect, beforeAll, vi } from "vitest";
import { network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost, sweepFrames, zoomSteps } from "../../__tests__/engine-sweep.js";

// Count the node glyph builds a frame runs: `frontierCircles` (an LOD frame) and `networkLayersFromCache`
// (an LOD-off position frame, which runs `nodeCircles`), so both legs do the same per-frame work.
const builds = vi.hoisted(() => ({ n: 0 }));
vi.mock("../glyphs.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../glyphs.js")>();
  return {
    ...mod,
    frontierCircles: (...args: Parameters<typeof mod.frontierCircles>) => {
      builds.n++;
      return mod.frontierCircles(...args);
    },
    networkLayersFromCache: (...args: Parameters<typeof mod.networkLayersFromCache>) => {
      builds.n++;
      return mod.networkLayersFromCache(...args);
    },
  };
});

/**
 * ENGINE-level per-frame guard for #506 (docs/agents/performance.md): a node border with no colour given
 * (`nodeBorder: { width }`) darkens each glyph's own fill. The baseline is the same border with an explicit
 * colour, drawn by the same engine on the same view.
 *
 * Triggers, the real ones, with LOD on and off:
 * - **WebGL**, LOD on: a `setTransform` zoom sweep (each call re-cuts and rebuilds the frontier's glyphs,
 *   `frontierCircles`, where the ring colours are darkened per glyph).
 * - **WebGL**, LOD off: position frames, `layout({ backend: "positions" })` with alternating positions
 *   (each rebuilds the nodes' instances, `nodeCircles`, as a layout tick or a drag frame does).
 * - **Canvas**, LOD off and on, zoom enabled: a `setTransform` sweep, one retained Scene rebuild per call
 *   (#309), where the stroke accessor answers each node's darkened fill.
 *
 * Signatures (deterministic): both legs run the same number of glyph builds, one per frame on WebGL.
 * Wall clock: the darkened leg's worst step (fastest of 3 reps) within 1.5× + a constant of the baseline's.
 *
 * Scale: WebGL at `perfN(100k, max 500k)`. Not 1M: this file's setup (the same for both legs) grows faster
 * than N, 38 s at 250k and 210 s at 500k, and at 1M it outran a 600 s hook timeout. The changed builds
 * themselves are measured at 1M in `node-border-shade-perf.test.ts`. MEASURED (local headless Chromium,
 * load ~9-14; darkened vs explicit colour, worst step): WebGL 500k LOD off 10.6 vs 10.1 ms, LOD on 5.2 vs
 * 5.1 ms; Canvas 40k LOD off 672 vs 683 ms, LOD on 19.6 vs 19.2 ms. Canvas at `perfN(20k, max 40k)`: a retained backend rebuilds one Scene entry per drawn node per
 * call, so ≈1M is not a per-frame regime there (`network-vector-zoom-perf`), and a LOD-off step costs
 * ~0.5 s at 40k, run 54 times per three legs, which the tier's per-file budget must hold.
 */
const W = 640;
const H = 400;
const SETUP_MS = perfBudget(600_000);
const RATIO = 1.5;
const PALETTE = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b"];

/** A binary-tree graph on a square grid (network-sweep-perf's fixture), plus a second, shifted layout. */
function fixture(n: number): { graph: NetworkGraph; positions: Float32Array; moved: Float32Array } {
  const cols = Math.max(1, Math.round(Math.sqrt(n)));
  const positions = new Float32Array(n * 2);
  const moved = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = (i % cols) * 8;
    positions[i * 2 + 1] = Math.floor(i / cols) * 8;
    moved[i * 2] = positions[i * 2]! + ((i % 3) - 1);
    moved[i * 2 + 1] = positions[i * 2 + 1]! + ((i % 5) - 2);
  }
  const source = new Int32Array(n - 1);
  const target = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) {
    source[i - 1] = i;
    target[i - 1] = Math.floor(i / 2);
  }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), positions, moved };
}

interface Leg { worstFrameMs: number; frames: number; builds: number }
interface Pair { base: Leg; shade: Leg }

const SHADE = { width: 1 };
const WHITE = { width: 1, color: "#ffffff" };
const WEBGL_N = perfN(100_000, { max: 500_000 });
const CANVAS_N = perfN(20_000, { max: 40_000 });
const results = new Map<string, Pair>();

beforeAll(async () => {
  const style = (nodeBorder: { width: number; color?: string }) => ({
    nodeRadius: 3,
    sizeMode: "screen" as const,
    nodeFill: (i: number) => PALETTE[(i >> 6) % PALETTE.length]!,
    nodeBorder,
  });
  /** Run `drive` with the baseline border, then the darkened one, then the baseline again (the better of the
   *  two baseline runs counts, so host drift cannot favour the darkened leg). */
  const pair = (net: ReturnType<typeof network>, drive: () => { worstFrameMs: number; frames: number }): Pair => {
    const leg = (nodeBorder: { width: number; color?: string }): Leg => {
      net.style(style(nodeBorder));
      const b0 = builds.n;
      const r = drive();
      return { ...r, builds: builds.n - b0 };
    };
    const a = leg(WHITE);
    const shade = leg(SHADE);
    const b = leg(WHITE);
    return { base: a.worstFrameMs <= b.worstFrameMs ? a : b, shade };
  };

  // WebGL.
  {
    const net = network(perfHost(W, H), { width: W, height: H });
    await net.whenReady();
    const { graph, positions, moved } = fixture(WEBGL_N);
    net.data(graph).style(style(WHITE)).layout({ backend: "positions", positions });
    // LOD off, position frames.
    const posSteps = zoomSteps(W, H, [1, 1, 1, 1, 1, 1]);
    let flip = false;
    results.set("webgl-off", pair(net, () => sweepFrames(posSteps, () => {
      flip = !flip;
      net.layout({ backend: "positions", positions: flip ? moved : positions });
    })));
    // LOD on, zoom sweep.
    net.lod({ declutter: true, maxAggregateRadius: 24 });
    results.set("webgl-on", pair(net, () => sweepFrames(zoomSteps(W, H), (t) => net.setTransform(t))));
    net.destroy();
  }
  // Canvas, zoom enabled: one Scene rebuild per setTransform.
  {
    const net = network(perfHost(W, H), { width: W, height: H, backend: "canvas" });
    await net.whenReady();
    const { graph, positions } = fixture(CANVAS_N);
    net.data(graph).style(style(WHITE)).layout({ backend: "positions", positions });
    net.enableZoom([1e-3, 1e3]);
    results.set("canvas-off", pair(net, () => sweepFrames(zoomSteps(W, H), (t) => net.setTransform(t))));
    net.lod({ declutter: true, maxAggregateRadius: 24 });
    results.set("canvas-on", pair(net, () => sweepFrames(zoomSteps(W, H), (t) => net.setTransform(t))));
    net.destroy();
  }
}, SETUP_MS);

describe("#506 node border shade: engine per-frame cost vs an explicit colour", () => {
  const cases = [
    { key: "webgl-off", label: `WebGL, LOD off, position frames (N=${WEBGL_N.toLocaleString()})`, c0: 10 },
    { key: "webgl-on", label: `WebGL, LOD on, zoom sweep (N=${WEBGL_N.toLocaleString()})`, c0: 10 },
    { key: "canvas-off", label: `Canvas, LOD off, zoom sweep (N=${CANVAS_N.toLocaleString()})`, c0: 20 },
    { key: "canvas-on", label: `Canvas, LOD on, zoom sweep (N=${CANVAS_N.toLocaleString()})`, c0: 20 },
  ] as const;
  for (const { key, label, c0 } of cases) {
    it(`${label}: the same glyph builds, within ${RATIO}× of the baseline frame`, () => {
      const r = results.get(key);
      if (!r) throw new Error("the sweep did not run");
      expect(r.shade.frames).toBe(r.base.frames);
      expect(r.shade.builds, "glyph builds vs the explicit-colour baseline").toBe(r.base.builds);
      if (key.startsWith("webgl")) expect(r.shade.builds, "one node glyph build per WebGL frame").toBe(r.shade.frames);
      const msg = `${label}: worst step ${r.shade.worstFrameMs.toFixed(1)} ms darkened vs ${r.base.worstFrameMs.toFixed(1)} ms explicit colour`;
      expect(r.shade.worstFrameMs, msg).toBeLessThan(RATIO * r.base.worstFrameMs + perfBudget(c0));
    });
  }
});
