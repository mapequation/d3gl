import { describe, it, expect, beforeAll, vi } from "vitest";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost } from "../../__tests__/engine-sweep.js";

// Count the fit's O(nodes) box (#427): once when a fitted transition starts, never per frame.
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
// Count the work a fitted frame's camera must NOT add: LOD cuts (the engine's one `cut` call site) and
// style resolutions (`resolveNodeRadii` runs once per resolved style).
const work = vi.hoisted(() => ({ cuts: 0, styleResolves: 0 }));
// The real module, for its live pass counters (#343): the mock below copies each export once, so a counter
// imported through it would stay at its value then.
const real = vi.hoisted(() => ({ lod: null as null | typeof import("../lod.js") }));
vi.mock("../lod.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lod.js")>();
  real.lod = mod;
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
 * ENGINE-level per-frame guard for position transitions (#328, AGENTS.md lifecycle §5): a transition
 * frame (`layout({ transition })`) against the frame it stands in for, a **streamed layout frame** (a
 * worker message's position copy + `scheduleLayoutRepaint`), both through the real engine on WebGL —
 * the interpolation, the LOD position pass, the re-emit and the GPU upload. The node guard
 * (`transition-perf.test.ts`) pins the same comparison at ~1M without the engine glue.
 *
 * Frames are stepped by hand: `requestAnimationFrame` is replaced by a queue this file flushes, so
 * each frame's callbacks run — and are timed — alone.
 *
 * Both reduction states on ONE engine (see network-sweep-perf.browser.test.ts, #287):
 *   - **LOD OFF**: both frames re-emit the whole graph. The transition may add its O(nodes)
 *     interpolation, nothing else: no buffer churn, no more upload than the streamed frame.
 *   - **LOD ON** (the module tree): the streamed frame recomputes the LOD geometry (positions + style);
 *     the transition only its positions, so it must come in cheaper, with the same upload.
 *   - **LOD ON, spatial source** (#343): the streamed frame rebuilds the spatial tree (topology, positions,
 *     style); the transition refits the tree it has (positions only) and rebuilds once when it settles.
 * Signatures: **no style pass** (`computeLODStyle`) and **no spatial tree build** on any transition frame,
 * while the streamed frames run them (non-vacuity) — the #328 contract itself, independent of how cheap
 * the style pass happens to be; GPU buffers created/deleted — none beyond the streamed frame's; uploaded
 * bytes per frame within the streamed frame's; `nodeFill` (resolved once at registration) never re-runs;
 * `linkStroke` no more often than on a streamed frame.
 *
 * **With `fit`** (#427) the camera eases along: each frame also moves the view — O(1): an interpolation, the
 * backend transform and the zoom re-seed — and the fit's O(nodes) box runs once, when the transition
 * starts, never per frame. A fitted transition frame is timed against an unfitted one at an equal view
 * (the transition is an hour long, so the camera's eased step is ~1e-12 and the drawn frontier is the
 * same): the camera is set exactly once per frame, the box 0 times over the frames (1 at the start), and
 * it runs exactly as many LOD cuts (one per frame with LOD on) and style resolutions (none), with no more
 * uploads or buffer churn; its median stays within 1.3× + 1 ms of the unfitted frame's.
 */

// 100k locally, the browser tier's CI scale too (#343): the LOD ON ratio below needs the style pass to be a
// real share of the streamed frame. Since the colour memo made that pass ~5× cheaper, at 50k the frame's
// fixed emit + upload dominates and the ratio sits on the bound with no regression present (0.60-0.64,
// quantised to 0.1 ms); at 100k it is 0.50. The count signature pins the contract itself at any N.
const N = perfN(100_000, { max: 200_000 });
const W = 640;
const H = 400;
const FRAMES = 10;
const ROUNDS = 3;
const SETUP_MS = perfBudget(120_000 + N / 2);
// Measured (local headless Chromium, best of 3 rounds of a 10-frame median): at 50k, LOD OFF streamed
// 0.5 ms / transition 0.6 ms (both 1.6 MB/frame uploaded), LOD ON 13.4 ms / 3.5 ms (449 / 453 KB/frame);
// at 200k, OFF 1.4 / 1.9 ms (6.4 MB/frame), ON 45.8 / 6.5 ms. The absolute ceilings are ~10× the transition's
// medians; the relative bounds below are what catch a style pass creeping back into the loop.
// Re-measured with #343's colour memo: at 100k OFF 0.6-0.7 / 0.8-1.0 ms, ON 4.0-4.1 / 2.0-2.1 ms (438 /
// 225 KB/frame), spatial 11.9-14.9 / 1.5-1.6 ms; at 200k ON 7.0 / 2.9 ms, spatial 24.9 / 2.9 ms. The
// ceilings are the same functions of N as before.
const FRAME_MS_OFF = perfBudget(4 + (4 * N) / 50_000);
const FRAME_MS_ON = perfBudget(20 + (10 * N) / 50_000);

/** A 3-level module hierarchy over a binary tree, and two unrelated position sets to move between. */
function fixture(n: number): { graph: ReturnType<typeof buildGraph>; modules: ModuleNode[]; a: Float32Array; b: Float32Array } {
  const side = Math.max(2, Math.round(Math.cbrt(n)));
  const modules: ModuleNode[] = new Array<ModuleNode>(n);
  for (let i = 0; i < n; i++) modules[i] = { id: i, path: [Math.floor(i / (side * side)) + 1, (Math.floor(i / side) % side) + 1, (i % side) + 1] };
  const source = new Int32Array(n - 1);
  const target = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) {
    source[i - 1] = i;
    target[i - 1] = Math.floor(i / 2);
  }
  const cols = Math.round(Math.sqrt(n));
  const a = new Float32Array(2 * n);
  const b = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    a[2 * i] = (i % cols) * 8;
    a[2 * i + 1] = Math.floor(i / cols) * 8;
    b[2 * i] = Math.floor(i / cols) * 8 + 3;
    b[2 * i + 1] = (i % cols) * 8 + 5;
  }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), modules, a, b };
}

/** Exposes the streamed-frame trigger and counts the camera's zoom re-seeds, without reaching into privates. */
class TransitionProbe extends Network {
  cameraSyncs = 0;
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  /** A worker message's repaint request — what the transport calls after copying the positions. */
  streamFrame(): void {
    this.scheduleLayoutRepaint();
  }
  protected override syncZoomToView(): void {
    this.cameraSyncs++;
    super.syncZoomToView();
  }
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

interface Phase {
  medianMs: number;
  /** `computeLODStyle` passes and spatial tree builds over the phase's frames (warm-up excluded). */
  stylePasses: number;
  treeBuilds: number;
  created: number;
  deleted: number;
  uploadedPerFrame: number;
  nodeFill: number;
  linkStroke: number;
  /** Over the timed frames (the last round's): the fit's box, the camera's zoom re-seeds, LOD cuts, style
   *  resolutions. */
  boxCalls: number;
  cameraSyncs: number;
  cuts: number;
  styleResolves: number;
}

interface Leg {
  streamed: Phase;
  transition: Phase;
  /** A transition with `fit` (#427), and the fit boxes its `layout()` call ran (the last round's). */
  fitted: Phase;
  fittedStartBoxes: number;
}

let registrationUploaded = 0;
let registrationNodeFill = 0;
let off: Leg;
let on: Leg;
let spatial: Leg;

beforeAll(async () => {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const spy = new GlBufferSpy();
  try {
    const net = new TransitionProbe(perfHost(W, H), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    globalThis.requestAnimationFrame = (cb) => {
      frames.set(++frameId, cb);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => void frames.delete(id);

    const { graph, modules, a, b } = fixture(N);
    let nodeFill = 0;
    let linkStroke = 0;
    const atStart = spy.mark();
    net
      .data(graph, { modules })
      .style({
        nodeRadius: 3,
        sizeMode: "screen",
        nodeFill: (i) => (nodeFill++, i % 2 ? "rgb(59,130,246)" : "rgb(245,158,11)"),
        linkStroke: (w) => (linkStroke++, w > 1 ? "rgb(100,116,139)" : "rgb(203,213,225)"),
      })
      .lod(false)
      .layout({ backend: "positions", positions: a });
    flush();
    registrationUploaded = spy.since(atStart).uploadedBytes;
    registrationNodeFill = nodeFill;

    const measure = (frame: (i: number) => void): Phase => {
      frame(0); // warm-up
      const fill0 = nodeFill;
      const stroke0 = linkStroke;
      const style0 = real.lod?.lodStylePasses ?? 0;
      const builds0 = real.lod?.mortonTopologyBuilds ?? 0;
      const [box0, syncs0, cuts0, styles0] = [box.calls, net.cameraSyncs, work.cuts, work.styleResolves];
      const mark = spy.mark();
      const ts: number[] = [];
      for (let i = 1; i <= FRAMES; i++) {
        const t0 = performance.now();
        frame(i);
        ts.push(performance.now() - t0);
      }
      const used = spy.since(mark);
      ts.sort((x, y) => x - y);
      return {
        medianMs: ts[Math.floor(ts.length / 2)]!,
        stylePasses: (real.lod?.lodStylePasses ?? 0) - style0,
        treeBuilds: (real.lod?.mortonTopologyBuilds ?? 0) - builds0,
        created: used.created,
        deleted: used.deleted,
        uploadedPerFrame: used.uploadedBytes / FRAMES,
        nodeFill: nodeFill - fill0,
        linkStroke: linkStroke - stroke0,
        boxCalls: box.calls - box0,
        cameraSyncs: net.cameraSyncs - syncs0,
        cuts: work.cuts - cuts0,
        styleResolves: work.styleResolves - styles0,
      };
    };
    /** Best of `ROUNDS` alternating rounds: the phase medians' minimum, so a burst of contention from
     *  a parallel run lands on one round, not on one phase. Counters are the last round's. */
    const best = (rounds: Phase[]): Phase => ({ ...rounds[rounds.length - 1]!, medianMs: Math.min(...rounds.map((r) => r.medianMs)) });
    const leg = (engine: TransitionProbe): Leg => {
      const streamed: Phase[] = [];
      const transition: Phase[] = [];
      const fitted: Phase[] = [];
      let fittedStartBoxes = 0;
      for (let round = 0; round < ROUNDS; round++) {
        // A streamed layout frame: the transport copies the message's positions, then the coalesced repaint.
        streamed.push(
          measure((i) => {
            graph.positions.set(i % 2 ? a : b);
            engine.streamFrame();
            flush();
          }),
        );
        // A transition frame: one queued frame of a long a → b transition (it never ends here).
        graph.positions.set(a);
        engine.layout({ backend: "positions", positions: b, transition: 3_600_000 });
        flush();
        transition.push(measure(() => flush()));
        engine.stopLayout();
        // The same with `fit` (#427): the camera eases along, from the view it is at (see the header).
        graph.positions.set(a);
        const box0 = box.calls;
        engine.layout({ backend: "positions", positions: b, transition: 3_600_000, fit: true });
        fittedStartBoxes = box.calls - box0;
        flush();
        fitted.push(measure(() => flush()));
        engine.stopLayout();
      }
      return { streamed: best(streamed), transition: best(transition), fitted: best(fitted), fittedStartBoxes };
    };

    off = leg(net);
    net.lod({}); // the module tree: a registration event (tree + geometry), then the same two phases
    flush();
    on = leg(net);
    net.lod({ source: "spatial" }); // the spatial tree (#343): rebuilt per streamed frame, refit per transition frame
    flush();
    spatial = leg(net);
    net.destroy();
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
    spy.restore();
  }
}, SETUP_MS);

describe(`network() position transition — per-frame cost vs a streamed layout frame at N=${N.toLocaleString()} (#328)`, () => {
  it("registers once and really uploads (non-vacuity)", () => {
    expect(registrationNodeFill, "nodeFill never ran — the fixture did not register").toBe(N);
    expect(registrationUploaded, "registration uploaded nothing — the spy is not observing the live context").toBeGreaterThan(0);
    for (const leg of [off, on, spatial]) {
      expect(leg.streamed.uploadedPerFrame, "a streamed frame uploaded nothing — positions never moved").toBeGreaterThan(0);
      expect(leg.transition.uploadedPerFrame, "a transition frame uploaded nothing — it never repainted").toBeGreaterThan(0);
    }
  });

  it("LOD ON: a transition frame runs no style pass and builds no tree; the streamed frame it stands in for does", () => {
    // The #328 contract as a count, not a timing: the streamed frames recompute the style every frame (the
    // spatial ones also rebuild the tree), the transition frames never do.
    expect(on.streamed.stylePasses, "the module leg's streamed frames ran no style pass — the signature is vacuous").toBeGreaterThanOrEqual(FRAMES);
    expect(on.transition.stylePasses, "style passes during the module tree's transition").toBe(0);
    expect(spatial.streamed.treeBuilds, "the spatial leg's streamed frames rebuilt no tree — the signature is vacuous").toBeGreaterThanOrEqual(FRAMES);
    expect(spatial.streamed.stylePasses).toBeGreaterThanOrEqual(FRAMES);
    expect(spatial.transition.treeBuilds, "spatial trees built during the transition").toBe(0);
    expect(spatial.transition.stylePasses, "style passes during the spatial tree's transition").toBe(0);
    expect(off.transition.stylePasses + off.transition.treeBuilds).toBe(0);
  });

  for (const [name, get, ceiling] of [["LOD OFF", () => off, FRAME_MS_OFF], ["LOD ON", () => on, FRAME_MS_ON], ["LOD ON spatial", () => spatial, FRAME_MS_ON]] as const) {
    it(`${name}: a transition frame re-derives, re-allocates and uploads nothing a streamed frame doesn't`, () => {
      const { streamed, transition } = get();
      expect(transition.nodeFill, "nodeFill re-ran during the transition").toBe(0);
      // Super-edge colours are resolved per emit under LOD (view-dependent: the frontier differs a little
      // between the two phases' positions); with LOD off both are exactly 0.
      expect(transition.linkStroke, `linkStroke ${transition.linkStroke} vs ${streamed.linkStroke} over ${FRAMES} frames`).toBeLessThanOrEqual(streamed.linkStroke * 1.1);
      expect(transition.created, "GPU buffers created during the transition").toBeLessThanOrEqual(streamed.created);
      expect(transition.deleted, "GPU buffers destroyed during the transition").toBeLessThanOrEqual(streamed.deleted);
      expect(
        transition.uploadedPerFrame,
        `transition uploads ${(transition.uploadedPerFrame / 1024).toFixed(0)} KB/frame vs streamed ${(streamed.uploadedPerFrame / 1024).toFixed(0)} KB/frame`,
      ).toBeLessThanOrEqual(streamed.uploadedPerFrame * 1.02 + 4096);
    });

    it(`${name}: a fitted transition frame (#427) moves the camera in O(1) — no fit box, cut, style pass or upload beyond the unfitted frame's`, () => {
      const { transition, fitted, fittedStartBoxes } = get();
      expect(fittedStartBoxes, "the fit box runs once, when the transition starts").toBe(1);
      expect(fitted.boxCalls, "the fit box ran on a transition frame").toBe(0);
      expect(fitted.cameraSyncs, "the camera is not set once per frame").toBe(FRAMES);
      expect(transition.cameraSyncs, "an unfitted transition moved the camera").toBe(0);
      expect(fitted.cuts, `LOD cuts: fitted ${fitted.cuts} vs unfitted ${transition.cuts}`).toBe(transition.cuts);
      expect(fitted.styleResolves, "a style pass ran on a fitted frame").toBe(0);
      expect(fitted.nodeFill, "nodeFill re-ran during the fitted transition").toBe(0);
      expect(fitted.linkStroke).toBeLessThanOrEqual(transition.linkStroke * 1.1);
      expect(fitted.created).toBeLessThanOrEqual(transition.created);
      expect(fitted.deleted).toBeLessThanOrEqual(transition.deleted);
      expect(fitted.uploadedPerFrame).toBeLessThanOrEqual(transition.uploadedPerFrame * 1.02 + 4096);
    });

    it(`${name}: a fitted transition frame stays within the unfitted frame's budget (#427)`, () => {
      const { transition, fitted } = get();
      const msg = `${name}: fitted ${fitted.medianMs.toFixed(2)}ms vs unfitted ${transition.medianMs.toFixed(2)}ms at N=${N.toLocaleString()}`;
      expect(fitted.medianMs, msg).toBeLessThanOrEqual(transition.medianMs * 1.3 + 1);
      expect(fitted.medianMs, msg).toBeLessThan(ceiling);
    });

    it(`${name}: a transition frame stays within the streamed frame's budget`, () => {
      const { streamed, transition } = get();
      const msg = `${name}: transition ${transition.medianMs.toFixed(2)}ms vs streamed ${streamed.medianMs.toFixed(2)}ms at N=${N.toLocaleString()}`;
      // ON the transition skips the style pass, so it must come in well under the streamed frame
      // (measured 0.26× at 50k, 0.14× at 200k before #343's colour memo; 0.50× at 100k and 0.41× at 200k
      // with it; the full geometry pass back in the loop lands ≈1×); the spatial tree's transition skips the
      // rebuild too (0.11-0.14×). OFF it adds only the interpolation to the same re-emit + upload (measured
      // 1.2-1.4×).
      if (name !== "LOD OFF") expect(transition.medianMs, msg).toBeLessThanOrEqual(streamed.medianMs * 0.6);
      else expect(transition.medianMs, msg).toBeLessThanOrEqual(streamed.medianMs * 1.5 + 2);
      expect(transition.medianMs, msg).toBeLessThan(ceiling);
    });
  }
});
