import { describe, it, expect, beforeAll } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost } from "../../__tests__/engine-sweep.js";

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
 * Signatures: GPU buffers created/deleted — none beyond the streamed frame's; uploaded bytes per frame
 * within the streamed frame's; `nodeFill` (resolved once at registration) never re-runs; `linkStroke`
 * no more often than on a streamed frame.
 */

const N = perfN(50_000, { max: 200_000 });
const W = 640;
const H = 400;
const FRAMES = 10;
const ROUNDS = 3;
const SETUP_MS = perfBudget(120_000 + N / 2);
// Measured (local headless Chromium, best of 3 rounds of a 10-frame median): at 50k, LOD OFF streamed
// 0.5 ms / transition 0.6 ms (both 1.6 MB/frame uploaded), LOD ON 13.4 ms / 3.5 ms (449 / 453 KB/frame);
// at 200k, OFF 1.4 / 1.9 ms (6.4 MB/frame), ON 45.8 / 6.5 ms. The absolute ceilings are ~10× the transition's
// medians; the relative bounds below are what catch a style pass creeping back into the loop.
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
  created: number;
  deleted: number;
  uploadedPerFrame: number;
  nodeFill: number;
  linkStroke: number;
}

interface Leg {
  streamed: Phase;
  transition: Phase;
}

let registrationUploaded = 0;
let registrationNodeFill = 0;
let off: Leg;
let on: Leg;

beforeAll(async () => {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const spy = new GlBufferSpy();
  try {
    const net = network(perfHost(W, H), { width: W, height: H, backend: "webgl" });
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
    const scheduleLayoutRepaint = (): void => (net as unknown as { scheduleLayoutRepaint(): void }).scheduleLayoutRepaint();

    const measure = (frame: (i: number) => void): Phase => {
      frame(0); // warm-up
      const fill0 = nodeFill;
      const stroke0 = linkStroke;
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
        created: used.created,
        deleted: used.deleted,
        uploadedPerFrame: used.uploadedBytes / FRAMES,
        nodeFill: nodeFill - fill0,
        linkStroke: linkStroke - stroke0,
      };
    };
    /** Best of `ROUNDS` alternating rounds: the phase medians' minimum, so a burst of contention from
     *  a parallel run lands on one round, not on one phase. Counters are the last round's. */
    const best = (rounds: Phase[]): Phase => ({ ...rounds[rounds.length - 1]!, medianMs: Math.min(...rounds.map((r) => r.medianMs)) });
    const leg = (engine: Network): Leg => {
      const streamed: Phase[] = [];
      const transition: Phase[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        // A streamed layout frame: the transport copies the message's positions, then the coalesced repaint.
        streamed.push(
          measure((i) => {
            graph.positions.set(i % 2 ? a : b);
            scheduleLayoutRepaint();
            flush();
          }),
        );
        // A transition frame: one queued frame of a long a → b transition (it never ends here).
        graph.positions.set(a);
        engine.layout({ backend: "positions", positions: b, transition: 3_600_000 });
        flush();
        transition.push(measure(() => flush()));
        engine.stopLayout();
      }
      return { streamed: best(streamed), transition: best(transition) };
    };

    off = leg(net);
    net.lod({}); // the module tree: a registration event (tree + geometry), then the same two phases
    flush();
    on = leg(net);
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
    for (const leg of [off, on]) {
      expect(leg.streamed.uploadedPerFrame, "a streamed frame uploaded nothing — positions never moved").toBeGreaterThan(0);
      expect(leg.transition.uploadedPerFrame, "a transition frame uploaded nothing — it never repainted").toBeGreaterThan(0);
    }
  });

  for (const [name, get, ceiling] of [["LOD OFF", () => off, FRAME_MS_OFF], ["LOD ON", () => on, FRAME_MS_ON]] as const) {
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

    it(`${name}: a transition frame stays within the streamed frame's budget`, () => {
      const { streamed, transition } = get();
      const msg = `${name}: transition ${transition.medianMs.toFixed(2)}ms vs streamed ${streamed.medianMs.toFixed(2)}ms at N=${N.toLocaleString()}`;
      // ON the transition skips the style pass, so it must come in well under the streamed frame
      // (measured 0.26× at 50k, 0.14× at 200k; the full geometry pass back in the loop lands ≈1×). OFF it
      // adds only the interpolation to the same re-emit + upload (measured 1.2-1.4×).
      if (name === "LOD ON") expect(transition.medianMs, msg).toBeLessThanOrEqual(streamed.medianMs * 0.6);
      else expect(transition.medianMs, msg).toBeLessThanOrEqual(streamed.medianMs * 1.5 + 2);
      expect(transition.medianMs, msg).toBeLessThan(ceiling);
    });
  }
});
