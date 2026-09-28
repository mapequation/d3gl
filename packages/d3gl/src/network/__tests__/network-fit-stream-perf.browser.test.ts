import { describe, it, expect, beforeAll, vi } from "vitest";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";
import type { ViewTransform } from "../../core/index.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost, zoomSteps } from "../../__tests__/engine-sweep.js";

// Count the fit's O(nodes) box (#327): once per streamed frame while the fit is on, never otherwise.
const box = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../fit.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../fit.js")>();
  return {
    ...mod,
    layoutBox: (...args: Parameters<typeof mod.layoutBox>) => {
      box.calls++;
      return mod.layoutBox(...args);
    },
  };
});
// Count the work the fit's glue must NOT add to a streamed frame: LOD cuts (the engine's one `cut` call
// site) and style resolutions (`resolveNodeRadii` runs once per resolved style). A fitted frame does
// exactly what an unfitted one does, plus the box — these pin that deterministically, in both reduction
// states, where a wall-clock ratio on a frontier-dominated frame cannot.
const work = vi.hoisted(() => ({ cuts: 0, styleResolves: 0 }));
vi.mock("../lod.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lod.js")>();
  return {
    ...mod,
    cut: (...args: Parameters<typeof mod.cut>) => {
      work.cuts++;
      return mod.cut(...args);
    },
  };
});
vi.mock("../glyphs.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../glyphs.js")>();
  return {
    ...mod,
    resolveNodeRadii: (...args: Parameters<typeof mod.resolveNodeRadii>) => {
      work.styleResolves++;
      return mod.resolveNodeRadii(...args);
    },
  };
});

/**
 * ENGINE-level per-frame guard for the streaming fit (#327, AGENTS.md lifecycle §5). The trigger is a
 * streamed layout frame, as the worker transport runs it: the message's position copy, then the coalesced
 * repaint (`scheduleLayoutRepaint` → `fitViewToLayout` → `rebuild`), timed alone. The node guard
 * (`fit-box-perf.test.ts`) pins the box itself at ~1M; this one pins what the engine does around it.
 *
 * The fit is switched on the way a user does, with a real `layout({ backend: "worker", fit: true })`.
 * Its worker is then stopped, and the file streams the frames itself: at guard scale a real worker posts
 * about one frame every 1-2 s, irregularly, and can run out of frames before a stream has been timed.
 * `requestAnimationFrame` is replaced by a queue this file flushes, so each repaint runs, and is timed,
 * alone.
 *
 * The timed streams alternate a seed spiral (stored rim-last, the box's slowest order) with its point
 * reflection through the box centre: every frame moves every node, but the box, and so the fitted view,
 * stays put. That matters with LOD on, where the drawn frontier follows the view: a view 1.5× too close
 * made a frame 3× dearer here (50 → 150 ms at 50k), which would swamp the fit's own cost. With the view
 * held equal, the fit-on and fit-off streams differ only by the fit's work, in both reduction states on
 * ONE engine (see network-sweep-perf.browser.test.ts, #287):
 *   - **LOD OFF** (every node drawn, re-emitted every frame): fit-on median ≤ 1.5 × fit-off + 1 ms;
 *   - **LOD ON** (the module tree; the frame recomputes its geometry, then re-cuts): ≤ 1.25 × + 1 ms;
 *   - and each under an absolute ceiling.
 * Signatures (deterministic): the box runs exactly once per streamed frame while the fit is on, and a
 * stream alternating the spiral with a 1.5× copy of it reframes on every frame; zero times with the fit
 * off; zero times over a `setTransform` zoom sweep, and on every streamed frame after that sweep has
 * taken the view over; and no streamed frame moves a taken-over view. A fitted stream also runs exactly as
 * many LOD cuts (one per frame with LOD on) and style resolutions (none) as an unfitted one.
 *
 * Why the LOD ON leg's wall-clock bound is only a coarse backstop: its frame is dominated by the frontier
 * the view draws (48.8 ms at 50k), so a ratio on it leaves room for several ms of extra work, and an
 * absolute delta on two noisy ~49 ms medians would flake. The fit's own work does not depend on LOD: the
 * box is the same O(nodes) pass either way, and the LOD OFF leg bounds it tightly. What LOD could add is
 * glue — an extra cut or a style re-resolution per fitted frame — and the counts above pin exactly that.
 * A larger frontier would not test the fit harder either: at an equal view it costs fit on and off alike.
 */

const N = perfN(50_000, { max: 200_000 });
const W = 640;
const H = 400;
const FRAMES = 10;
const ROUNDS = 3;
const AFTER_RELEASE = 3;
const SETUP_MS = perfBudget(120_000 + N / 2);
// Measured (local headless Chromium, load average ~9, best of 3 rounds of a 10-frame median): at 50k,
// LOD OFF fit on 0.6 / off 0.4-0.5 ms, LOD ON 48.9 / 48.8 ms; at 200k, OFF 2.1 / 1.5-1.6 ms, ON 14.7 /
// 14.1 ms. The LOD ON frame follows the frontier the fitted view draws (this fixture's coarser top level
// at 200k draws less), not N. Ceilings are ~10× the fit-on medians at the local default, split into
// constant + linear terms; the ratio bounds above are what pin the fit's own cost.
const FRAME_MS_OFF = perfBudget(4 + (4 * N) / 50_000);
const FRAME_MS_ON = perfBudget(400 + (100 * N) / 50_000);

/** Exposes the view and the streamed-frame trigger to the test, without reaching into privates. */
class FitProbe extends Network {
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  get view(): ViewTransform {
    return { ...this.transform };
  }
  /** A worker message's repaint request — what the transport calls after copying the positions. */
  streamFrame(): void {
    this.scheduleLayoutRepaint();
  }
}

/** A 3-level module hierarchy over a binary tree (the transition guard's fixture), and three position
 *  sets to stream: a golden-angle spiral stored rim-last (`a`), its point reflection through its box
 *  centre (`m`: same box, same storage order), and `a` 1.5× larger (`b`). */
function fixture(n: number): { graph: NetworkGraph; modules: ModuleNode[]; a: Float32Array; m: Float32Array; b: Float32Array } {
  const side = Math.max(2, Math.round(Math.cbrt(n)));
  const modules: ModuleNode[] = new Array<ModuleNode>(n);
  for (let i = 0; i < n; i++) modules[i] = { id: i, path: [Math.floor(i / (side * side)) + 1, (Math.floor(i / side) % side) + 1, (i % side) + 1] };
  const source = new Int32Array(n - 1);
  const target = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) {
    source[i - 1] = i;
    target[i - 1] = Math.floor(i / 2);
  }
  const a = new Float32Array(2 * n);
  const m = new Float32Array(2 * n);
  const b = new Float32Array(2 * n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = 4 * Math.sqrt(i + 0.5);
    const x = r * Math.cos(i * golden);
    const y = r * Math.sin(i * golden);
    a[2 * i] = x;
    a[2 * i + 1] = y;
    b[2 * i] = 1.5 * x;
    b[2 * i + 1] = 1.5 * y;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, a[2 * i] ?? 0); maxX = Math.max(maxX, a[2 * i] ?? 0);
    minY = Math.min(minY, a[2 * i + 1] ?? 0); maxY = Math.max(maxY, a[2 * i + 1] ?? 0);
  }
  for (let i = 0; i < n; i++) {
    m[2 * i] = minX + maxX - (a[2 * i] ?? 0);
    m[2 * i + 1] = minY + maxY - (a[2 * i + 1] ?? 0);
  }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), modules, a, m, b };
}

/** The frame queue that stands in for `requestAnimationFrame` for the whole file. */
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
function flush(): void {
  const due = [...frames.values()];
  frames.clear();
  const now = performance.now();
  for (const cb of due) cb(now);
}

interface Stream {
  medianMs: number;
  /** `layoutBox` calls over the timed frames (the last round's). */
  boxCalls: number;
  /** LOD `cut` calls and style resolutions over the timed frames (the last round's). */
  cuts: number;
  styleResolves: number;
}

interface Leg {
  fitOn: Stream;
  fitOff: Stream;
  /** Over a stream alternating `a` and `b` with the fit on: distinct view scales, and `layoutBox` calls. */
  reframeScales: number;
  reframeBoxCalls: number;
  /** `layoutBox` calls over the zoom sweep that took the view over mid-stream, and over the frames after it. */
  sweepBoxCalls: number;
  afterReleaseBoxCalls: number;
  /** Did any streamed frame after the sweep move the taken-over view? */
  afterReleaseMoved: boolean;
}

let off: Leg;
let on: Leg;

beforeAll(async () => {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  try {
    const net = new FitProbe(perfHost(W, H), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    globalThis.requestAnimationFrame = (cb) => {
      frames.set(++frameId, cb);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => void frames.delete(id);
    const { graph, modules, a, m, b } = fixture(N);
    net.data(graph, { modules }).style({ nodeRadius: 3, sizeMode: "screen" }).enableZoom([1e-4, 1e4]);

    /** Start a worker stream with the fit on or off, then stop its worker (see the header). */
    const startStream = (fit: boolean): void => {
      net.layout({ backend: "worker", fit, multilevel: false });
      net.stopLayout();
      flush();
    };
    /** One streamed layout frame: the transport's position copy, then the coalesced repaint. */
    const streamFrame = (positions: Float32Array): void => {
      graph.positions.set(positions);
      net.streamFrame();
      flush();
    };
    /** Time {@link FRAMES} streamed frames alternating `a` and `m` (the fitted view holds still). */
    const measure = (): Stream => {
      streamFrame(a); // warm-up, and frames the view (fit on) that the fit-off stream then keeps
      const calls0 = box.calls;
      const cuts0 = work.cuts;
      const resolves0 = work.styleResolves;
      const ts: number[] = [];
      for (let i = 1; i <= FRAMES; i++) {
        const t0 = performance.now();
        streamFrame(i % 2 ? m : a);
        ts.push(performance.now() - t0);
      }
      ts.sort((x, y) => x - y);
      return {
        medianMs: ts[Math.floor(ts.length / 2)] ?? Infinity,
        boxCalls: box.calls - calls0,
        cuts: work.cuts - cuts0,
        styleResolves: work.styleResolves - resolves0,
      };
    };
    /** Best of `ROUNDS` alternating rounds: the medians' minimum, so a burst of contention from a parallel
     *  run lands on one round, not on one phase. Counters are the last round's. */
    const best = (rounds: Stream[]): Stream => {
      const last = rounds[rounds.length - 1] ?? { medianMs: Infinity, boxCalls: -1, cuts: -1, styleResolves: -1 };
      return { ...last, medianMs: Math.min(...rounds.map((r) => r.medianMs)) };
    };

    const leg = (): Leg => {
      const fitOn: Stream[] = [];
      const fitOff: Stream[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        startStream(true);
        fitOn.push(measure());
        startStream(false);
        fitOff.push(measure());
      }
      // Non-vacuity: a growing/shrinking layout reframes on every streamed frame.
      startStream(true);
      streamFrame(a);
      const beforeReframe = box.calls;
      const ks = new Set<number>();
      for (let i = 1; i <= FRAMES; i++) {
        streamFrame(i % 2 ? b : a);
        ks.add(net.view.k);
      }
      const reframeBoxCalls = box.calls - beforeReframe;
      // Take the view over mid-stream with a zoom sweep, as a zoom-to or a saved camera would.
      const beforeSweep = box.calls;
      for (const t of zoomSteps(W, H)) net.setTransform(t);
      const sweepBoxCalls = box.calls - beforeSweep;
      const held = net.view;
      const beforeAfter = box.calls;
      let afterReleaseMoved = false;
      for (let i = 1; i <= AFTER_RELEASE; i++) {
        streamFrame(i % 2 ? b : a);
        const v = net.view;
        if (v.k !== held.k || v.x !== held.x || v.y !== held.y) afterReleaseMoved = true;
      }
      const afterReleaseBoxCalls = box.calls - beforeAfter;
      return { fitOn: best(fitOn), fitOff: best(fitOff), reframeScales: ks.size, reframeBoxCalls, sweepBoxCalls, afterReleaseBoxCalls, afterReleaseMoved };
    };

    net.lod(false);
    flush();
    off = leg();
    net.lod({}); // the module tree: the streamed frame recomputes its geometry, then re-cuts it at the view
    flush();
    on = leg();
    net.destroy();
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
  }
}, SETUP_MS);

describe(`network() streaming fit — per streamed frame at N=${N.toLocaleString()} (#327)`, () => {
  for (const [name, get, ceiling, ratio, cutsPerFrame] of [["LOD OFF", () => off, FRAME_MS_OFF, 1.5, 0], ["LOD ON", () => on, FRAME_MS_ON, 1.25, 1]] as const) {
    it(`${name}: the box runs once per streamed frame while fitting, and never on zoom frames or after release`, () => {
      const leg = get();
      expect(leg.reframeScales, "non-vacuity: the fit did not follow the layout's size").toBe(2);
      expect(leg.reframeBoxCalls, `box calls over ${FRAMES} reframing frames`).toBe(FRAMES);
      expect(leg.fitOn.boxCalls, `box calls over ${FRAMES} fitted frames`).toBe(FRAMES);
      expect(leg.fitOff.boxCalls, "the box ran with the fit off").toBe(0);
      expect(leg.sweepBoxCalls, "a setTransform zoom frame ran the box").toBe(0);
      expect(leg.afterReleaseBoxCalls, "a streamed frame ran the box after the view was taken over").toBe(0);
      expect(leg.afterReleaseMoved, "a streamed frame moved a taken-over view").toBe(false);
    });

    it(`${name}: a fitted streamed frame runs no extra LOD cut or style resolution`, () => {
      const { fitOn, fitOff } = get();
      expect(fitOff.cuts, `non-vacuity: LOD cuts over ${FRAMES} unfitted frames`).toBe(FRAMES * cutsPerFrame);
      expect(fitOn.cuts, "the fit added LOD cuts to a streamed frame").toBe(fitOff.cuts);
      expect(fitOff.styleResolves, "an unfitted streamed frame re-resolved the style").toBe(0);
      expect(fitOn.styleResolves, "the fit re-resolved the style on a streamed frame").toBe(0);
    });

    it(`${name}: a fitted streamed frame stays within its budget`, () => {
      const { fitOn, fitOff } = get();
      const msg = `${name}: fit on ${fitOn.medianMs.toFixed(2)}ms vs fit off ${fitOff.medianMs.toFixed(2)}ms at N=${N.toLocaleString()}`;
      expect(fitOn.medianMs, msg).toBeLessThanOrEqual(fitOff.medianMs * ratio + perfBudget(1));
      expect(fitOn.medianMs, msg).toBeLessThan(ceiling);
    });
  }
});
