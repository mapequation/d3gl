import { describe, it, expect, beforeAll, vi } from "vitest";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";
import * as lod from "../lod.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost } from "../../__tests__/engine-sweep.js";
import type { ViewTransform } from "../../core/index.js";

/**
 * ENGINE-level per-frame guard for a **followed stream** (#454, AGENTS.md lifecycle §5): a warm layout
 * streamed without a transition, which the engine eases toward frame by frame, from the positions on screen —
 * a nested map's (`layout({ backend: "worker", nested: { warm: true }, fit: true })`, the Navigator's switch to
 * Nested layout) and a force layout's (`layout({ backend: "worker", warm: true, fit: true })`, the switch back),
 * through the one follower they share. Each of its frames is a position transition's (the interpolation, the LOD position pass, the
 * re-emit) plus the stream's fit: the O(nodes) box of the live leaves and the camera, once per frame. It
 * stands in for a **fitted streamed frame** (a worker message's position copy, the full geometry pass, the
 * same box), so it must cost no more than one and re-derive, allocate and upload nothing one doesn't. The
 * reference is the followed frames' own positions **replayed** as fitted streamed frames, from the same view:
 * the same frontier and camera moves, painted as a stream paints them. (With LOD on, a frontier that changes
 * from frame to frame re-creates a few small buffers on a streamed frame too — measured 9 created and 18
 * destroyed over 10 frames at 20k, on the replay as on the followed frames — so a fixed position pair would
 * be no reference for that count.)
 *
 * Its own file, not a leg of `network-transition-perf.browser.test.ts`: that file mocks `lod.js`, `fit.js` and
 * `glyphs.js` to count calls, and a mocked module does not load in a worker, so a layout worker started there
 * never starts. Counted here without mocks: `computeLODStyle` passes (lod.js's live counter), GPU buffer
 * traffic (`GlBufferSpy`), the camera's re-seeds (one per reframe) and `nodeFill` calls.
 *
 * Frames are stepped by hand (`requestAnimationFrame` queued, flushed here) on a virtual clock 16 ms apart,
 * once the worker's first frame has started the ease, so every timed frame is mid-ease; no worker message is
 * taken meanwhile, so each is the ease's own. Both reduction states on ONE engine (#287).
 */

const N = perfN(100_000, { max: 200_000 });
const W = 640;
const H = 400;
const FRAMES = 10;
const ROUNDS = 2;
const SETUP_MS = perfBudget(240_000 + N);
// The transition guard's ceilings (network-transition-perf.browser.test.ts), for the same fixture: a followed
// frame is a transition frame plus the stream's O(nodes) box.
const FRAME_MS_OFF = perfBudget(4 + (4 * N) / 50_000);
const FRAME_MS_ON = perfBudget(20 + (10 * N) / 50_000);
const wallClock = performance.now.bind(performance);

/** A 3-level module hierarchy over a binary tree, and two position sets: a grid, and the grid transposed. */
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

/** Exposes the streamed-frame trigger and counts the camera's reframes, without reaching into privates. */
class FollowProbe extends Network {
  cameraSyncs = 0;
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  /** A worker message's repaint request — what the transport calls after copying the positions. */
  streamFrame(): void {
    this.scheduleLayoutRepaint();
  }
  get camera(): ViewTransform {
    return { ...this.transform };
  }
  protected override syncZoomToView(): void {
    this.cameraSyncs++;
    super.syncZoomToView();
  }
}

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
  stylePasses: number;
  created: number;
  deleted: number;
  uploadedPerFrame: number;
  nodeFill: number;
  cameraSyncs: number;
  /** Every timed frame moved the nodes (the ease was running). */
  moved: boolean;
}
interface Leg {
  followed: Phase;
  /** The followed frames' own positions, replayed as fitted streamed frames: what the stream would cost painted as it lands. */
  replayed: Phase;
}

let off: Leg;
let on: Leg;
/** The same frames, followed on a warm **force** layout's stream (#454: Nested layout switched off). */
let flatOff: Leg;
let flatOn: Leg;

beforeAll(async () => {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const spy = new GlBufferSpy();
  try {
    const host = perfHost(W, H);
    const net = new FollowProbe(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    net.enableZoom([1e-6, 1e6]); // the fit re-seeds d3-zoom every frame, as in the Navigator
    globalThis.requestAnimationFrame = (cb) => {
      frames.set(++frameId, cb);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => void frames.delete(id);

    const { graph, modules, a, b } = fixture(N);
    let nodeFill = 0;
    net
      .data(graph, { modules })
      .style({ nodeRadius: 3, sizeMode: "screen", nodeFill: (i) => (nodeFill++, i % 2 ? "rgb(59,130,246)" : "rgb(245,158,11)") })
      .lod(false)
      .layout({ backend: "positions", positions: a });
    flush();

    const measure = (frame: () => boolean, after?: () => void): Phase => {
      frame(); // warm-up
      after?.();
      const fill0 = nodeFill;
      const style0 = lod.lodStylePasses;
      const syncs0 = net.cameraSyncs;
      const mark = spy.mark();
      const ts: number[] = [];
      let moved = true;
      for (let i = 0; i < FRAMES; i++) {
        const t0 = wallClock();
        moved = frame() && moved;
        ts.push(wallClock() - t0);
        after?.(); // untimed
      }
      const used = spy.since(mark);
      ts.sort((x, y) => x - y);
      return {
        medianMs: ts[Math.floor(ts.length / 2)] ?? Number.NaN,
        stylePasses: lod.lodStylePasses - style0,
        created: used.created,
        deleted: used.deleted,
        uploadedPerFrame: used.uploadedBytes / FRAMES,
        nodeFill: nodeFill - fill0,
        cameraSyncs: net.cameraSyncs - syncs0,
        moved,
      };
    };
    const best = (rounds: Phase[]): Phase => ({ ...(rounds[rounds.length - 1] as Phase), medianMs: Math.min(...rounds.map((r) => r.medianMs)) });
    /** The positions changed since `prev` (then `prev` takes them). */
    const movedSince = (prev: Float32Array): boolean => {
      const p = graph.positions;
      let moved = false;
      for (let i = 0; i < p.length; i++) {
        if (p[i] !== prev[i]) {
          moved = true;
          break;
        }
      }
      prev.set(p);
      return moved;
    };

    /** The followed stream: a warm nested map's, or a warm force layout's (the same follower, #454). */
    const leg = async (kind: "nested" | "flat"): Promise<Leg> => {
      const followed: Phase[] = [];
      const replayed: Phase[] = [];
      // A fitted streamed frame: the fit on, as `layout({ fit: true })` sets it, and the repaint a worker message
      // requests (the transition guard's fit-on-layout leg drives it the same way).
      const internals = net as unknown as { fitOnLayout: boolean };
      for (let round = 0; round < ROUNDS; round++) {
        // The followed stream, from `a`: wait for the worker's first frame to start the ease, then time its frames.
        graph.positions.set(a);
        let virtual = 0;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => virtual);
        try {
          if (kind === "nested") net.layout({ backend: "worker", nested: { warm: true, iterations: 1 }, fit: true });
          else net.layout({ backend: "worker", warm: true, fit: true });
          const prev = a.slice();
          let view: ViewTransform = { k: 1, x: 0, y: 0 };
          const t0 = wallClock();
          while (!movedSince(prev)) {
            // The worker's first frame follows its start (a few seconds at 100k under the dev server's unbundled
            // worker modules) and, with LOD off, the module tree's build on a worker (#428).
            if (wallClock() - t0 > perfBudget(120_000)) throw new Error("the followed stream never moved the nodes");
            await new Promise((r) => setTimeout(r, 5));
            virtual += 16;
            flush();
          }
          view = net.camera;
          const seen: Float32Array[] = [];
          followed.push(
            measure(
              () => {
                virtual += 16;
                flush();
                return movedSince(prev);
              },
              () => seen.push(graph.positions.slice()),
            ),
          );
          net.stopLayout();
          // The same positions, from the same view, as fitted streamed frames.
          net.setTransform(view);
          graph.positions.set(seen[0] ?? a);
          internals.fitOnLayout = true;
          let r = 1;
          replayed.push(
            measure(() => {
              graph.positions.set(seen[Math.min(r++, seen.length - 1)] ?? a);
              net.streamFrame();
              flush();
              return true;
            }),
          );
          internals.fitOnLayout = false;
        } finally {
          net.stopLayout();
          clock.mockRestore();
        }
        graph.positions.set(a);
        net.setTransform({ k: 1, x: 0, y: 0 });
        flush();
      }
      return { followed: best(followed), replayed: best(replayed) };
    };

    off = await leg("nested");
    flatOff = await leg("flat");
    net.lod({}); // the module tree: a registration event (tree + geometry), then the same two phases
    flush();
    on = await leg("nested");
    flatOn = await leg("flat");
    net.destroy();
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
    spy.restore();
  }
}, SETUP_MS);

describe(`network() followed warm stream (#454) — per-frame cost vs a fitted streamed frame at N=${N.toLocaleString()}`, () => {
  for (const [name, get, ceiling] of [
    ["LOD OFF", () => off, FRAME_MS_OFF],
    ["LOD ON", () => on, FRAME_MS_ON],
    ["LOD OFF, warm force layout", () => flatOff, FRAME_MS_OFF],
    ["LOD ON, warm force layout", () => flatOn, FRAME_MS_ON],
  ] as const) {
    it(`${name}: every timed frame is the ease's, and the streamed frames really upload (non-vacuity)`, () => {
      const { replayed: streamed, followed } = get();
      expect(followed.moved, "a timed frame left the nodes where they were: the ease was not running").toBe(true);
      expect(streamed.uploadedPerFrame, "a streamed frame uploaded nothing").toBeGreaterThan(0);
      expect(followed.uploadedPerFrame, "a followed frame uploaded nothing: it never repainted").toBeGreaterThan(0);
    });

    it(`${name}: a followed frame re-derives, re-allocates and uploads nothing a fitted streamed frame doesn't`, () => {
      const { replayed: streamed, followed } = get();
      if (name.startsWith("LOD ON")) expect(streamed.stylePasses, "non-vacuity: the streamed frames ran no style pass").toBeGreaterThanOrEqual(FRAMES);
      expect(followed.stylePasses, "a style pass on a followed frame").toBe(0);
      expect(followed.nodeFill, "nodeFill re-ran on a followed frame").toBe(0);
      expect(followed.created, "GPU buffers created during the followed frames").toBeLessThanOrEqual(streamed.created);
      expect(followed.deleted, "GPU buffers destroyed during the followed frames").toBeLessThanOrEqual(streamed.deleted);
      expect(
        followed.uploadedPerFrame,
        `followed uploads ${(followed.uploadedPerFrame / 1024).toFixed(0)} KB/frame vs streamed ${(streamed.uploadedPerFrame / 1024).toFixed(0)} KB/frame`,
      ).toBeLessThanOrEqual(streamed.uploadedPerFrame * 1.02 + 4096);
      // The fit: at most one reframe per frame, as a fitted streamed frame has — and it did reframe.
      expect(followed.cameraSyncs, "more than one reframe per frame").toBeLessThanOrEqual(FRAMES);
      expect(followed.cameraSyncs, "non-vacuity: the fit framed no followed frame").toBeGreaterThan(0);
    });

    it(`${name}: a followed frame stays within a fitted streamed frame's budget`, () => {
      const { replayed: streamed, followed } = get();
      const msg = `${name}: followed ${followed.medianMs.toFixed(2)}ms vs fitted streamed ${streamed.medianMs.toFixed(2)}ms at N=${N.toLocaleString()}`;
      console.log(msg);
      // ON the followed frame skips the style pass (the transition guard measures a transition frame at
      // 0.4-0.6× a streamed one); OFF it adds the interpolation to the same re-emit, box and upload.
      if (name.startsWith("LOD ON")) expect(followed.medianMs, msg).toBeLessThanOrEqual(streamed.medianMs * 0.8 + 1);
      else expect(followed.medianMs, msg).toBeLessThanOrEqual(streamed.medianMs * 1.5 + 2);
      expect(followed.medianMs, msg).toBeLessThan(ceiling);
    });
  }
});
