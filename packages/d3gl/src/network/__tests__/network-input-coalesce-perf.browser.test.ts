import { describe, it, expect, beforeAll, vi } from "vitest";
import { zoomTransform } from "d3-zoom";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";
import type { ViewTransform } from "../../core/index.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost } from "../../__tests__/engine-sweep.js";

// Count LOD frontier passes. `cut` is the engine's one call site per frontier: the lane's select runs
// `computeFrontier`, which cuts once and then declutters and gathers the super-edges of that cut. The
// spy also keeps the last cut's size, so each leg can prove the frontier it drew is as large as claimed.
const work = vi.hoisted(() => ({ cuts: 0, lastCut: 0 }));
vi.mock("../lod.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lod.js")>();
  return {
    ...mod,
    cut: (...args: Parameters<typeof mod.cut>) => {
      work.cuts++;
      const frontier = mod.cut(...args);
      work.lastCut = frontier.length;
      return frontier;
    },
  };
});

/**
 * ENGINE-level per-frame guard for pan/zoom and node-drag INPUT (#367, AGENTS.md lifecycle §5).
 *
 * The trigger is the real input path: `WheelEvent`s and a pan's `MouseEvent`s through d3-zoom's own
 * listeners, and a node drag's `PointerEvent`s through the engine's grab. Each used to run a whole frame
 * inside its handler — a wheel event `setTransform` → lane re-emit → LOD cut + declutter + super-edge
 * gather + render, a drag move a full `rebuild()` — so the work scaled with the event rate: at 325k nodes a
 * zoom gesture was one 50-72 ms long task per wheel event. Now input only records its latest state and the
 * engine draws ONCE in its next animation frame, with a streamed layout frame that lands in the same frame
 * folded in. `requestAnimationFrame` is replaced by a queue this file flushes, so "many events within one
 * frame" is exact: a burst of {@link BURST} events is dispatched, then one frame runs.
 *
 * Fixture: ≈1M drawables — N nodes on a grid and ≈3N edges (row, column and diagonal neighbours), with an
 * 8×8-block module partition for the LOD tree — viewed WHOLE, so every drawable is on screen. ONE WebGL
 * engine runs three reduction states (a second WebGL engine after a large first one stalls for seconds,
 * #287):
 *   - **LOD OFF** — every node and edge drawn; a pan/zoom frame is a render of the static lane, a drag
 *     frame re-emits the whole graph's positions (the O(N) work that must not run per move);
 *   - **LOD ON, aggregate frontier** — the module tree with its default cut and declutter (the common case);
 *   - **LOD ON, all leaves** — every module expanded and declutter off, so the frontier IS the ≈N visible
 *     nodes and their ≈3N edges (LOD may not shrink the set this guard measures).
 * Each state runs a wheel burst, a pan burst (mouse moves), a node-drag burst, and a burst mixing wheel
 * ticks, a streamed layout frame and drag moves.
 *
 * Signatures (deterministic, every state, every round):
 *   - no LOD cut and no render inside ANY input handler;
 *   - the frame after a burst runs exactly one render and one LOD cut with LOD on (none with it off),
 *     however many events and sources were pending;
 *   - the frame draws the LATEST transform (the one d3-zoom continues the next gesture from).
 * Wall clock (the order-of-magnitude backstop; best of {@link ROUNDS}):
 *   - the input handlers cost a constant per event, independent of N — a per-event frame at this N costs
 *     tens to hundreds of ms, so the ceiling sits orders of magnitude below it;
 *   - the coalesced frame after a burst costs ONE pass: at most 2× (+2 ms) the frame after a single event
 *     at the same state (a programmatic `setTransform` at the drawn view for pan/zoom, one move's frame for
 *     a drag, one streamed frame for the mix) — a pass per event would be 8-16× — under an absolute ceiling.
 *     Except LOD OFF pan/zoom, which is COUNT-ONLY here: its frame re-emits nothing (the full-detail lane is
 *     static) and only renders, and `render()` is counted, not drawn (see {@link Probe}), so both its frame
 *     and its reference read ~0 ms and a clock would assert nothing. Its one-render-per-frame count above is
 *     the signature; network-sweep-perf.browser.test.ts owns that draw's CPU cost. Its handlers are timed.
 */

const N = perfN(250_000, { max: 250_000 });
const COLS = Math.max(2, Math.round(Math.sqrt(N)));
const ROWS = Math.ceil(N / COLS);
const SPACING = 8;
const W = 640;
const H = 400;
/** Events per burst: all of them land before the frame runs. */
const BURST = 16;
/** Bursts per kind and state: every one is checked for the counts, the best one for the clock. */
const ROUNDS = 3;
// Setup builds the graph, the static full-detail emit and two LOD trees at N: a harness limit, not a budget.
const SETUP_MS = perfBudget(240_000 + N);
// Measured at 250k (local headless Chromium, load average ~15 from other agents; best of 3): the handlers
// took ≤ 0.2 ms per 16-event burst in every state. The costliest frame is the all-leaves one — 220-230 ms for
// pan/zoom (cut + super-edge gather over 250k nodes / 748k edges), 280-290 ms with a drag or a streamed frame
// folded in — and each coalesced frame measured 0.96-1.05× its single-event frame. Before #367 a burst ran
// that frame once PER EVENT inside the handlers: 16 × ~225 ms ≈ 3.6 s. The handler ceiling is a constant per
// event (~80× the measurement); the frame ceiling is constant + linear in N, ~10× the costliest frame.
const HANDLER_MS_PER_EVENT = perfBudget(1);
const FRAME_MS = perfBudget(200 + (2800 * N) / 250_000);
/** A coalesced frame may cost this much more than one event's frame, and no more: one pass, not a pass per event. */
const FRAME_RATIO = 2;
const FRAME_SLACK_MS = perfBudget(2);

/**
 * Exposes the drawn view, the render count, the gesture flag and the streamed-frame trigger. `render()` is
 * COUNTED, not submitted to the GPU: this guard times the CPU work input and the frame it asks for do — the
 * handlers, the lane's frontier pass, the instance upload — and asserts one render per frame. Rasterising a
 * ≈1M-instance frame on the headless runner's software GL (SwiftShader) takes seconds per draw and queues
 * behind every earlier one, which stalled the file for minutes without being work this guard is about; the
 * CPU side of a draw is a handful of instanced draw calls, pinned by network-sweep-perf.browser.test.ts.
 */
class Probe extends Network {
  renders = 0;
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  override render(): this {
    this.renders++;
    return this;
  }
  get drawnView(): ViewTransform {
    return { ...this.transform };
  }
  get gestureActive(): boolean {
    return this.interacting;
  }
  /** A worker message's repaint request — what the transport calls after copying a frame's positions. */
  streamFrame(): void {
    this.scheduleLayoutRepaint();
  }
}

function fixture(n: number): { graph: ReturnType<typeof buildGraph>; positions: Float32Array; modules: ModuleNode[] } {
  const positions = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    positions[2 * i] = (i % COLS) * SPACING;
    positions[2 * i + 1] = Math.floor(i / COLS) * SPACING;
  }
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % COLS;
    if (col + 1 < COLS && i + 1 < n) { source.push(i); target.push(i + 1); }
    if (i + COLS < n) { source.push(i); target.push(i + COLS); }
    if (col + 1 < COLS && i + COLS + 1 < n) { source.push(i); target.push(i + COLS + 1); }
  }
  const BLOCK = 8;
  const blocksPerRow = Math.ceil(COLS / BLOCK);
  const modules: ModuleNode[] = Array.from({ length: n }, (_, id) => {
    const col = id % COLS;
    const row = Math.floor(id / COLS);
    return { id, path: [1 + Math.floor(row / BLOCK) * blocksPerRow + Math.floor(col / BLOCK), 1 + id] };
  });
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), positions, modules };
}

/** The frame queue standing in for `requestAnimationFrame` while the fixture runs. */
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
function flush(): void {
  const due = [...frames.values()];
  frames.clear();
  const now = performance.now();
  for (const cb of due) cb(now);
}

/** One burst: what ran inside the input handlers, and what the one frame after it ran. */
interface Burst {
  handlerMs: number;
  handlerCuts: number;
  handlerRenders: number;
  frameMs: number;
  frameCuts: number;
  frameRenders: number;
  drawnIsLatest: boolean;
  /** The single-event frame at the same state (see the header). */
  oneMs: number;
}

const KINDS = ["wheel", "pan", "drag", "mixed"] as const;
type Kind = (typeof KINDS)[number];

interface Leg {
  lod: boolean;
  bursts: Record<Kind, Burst[]>;
  /** Nodes the leg drew: the last LOD cut's size, or every node with LOD off. */
  drawn: number;
}

const legs: Record<string, Leg> = {};
let edges = 0;

async function until(done: () => boolean, maxMs = 5000): Promise<void> {
  const t0 = performance.now();
  while (!done() && performance.now() - t0 < maxMs) await new Promise((res) => setTimeout(res, 10));
}

beforeAll(async () => {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const host = perfHost(W, H);
  const net = new Probe(host, { width: W, height: H, backend: "webgl" });
  try {
    await net.whenReady();
    globalThis.requestAnimationFrame = (cb) => {
      frames.set(++frameId, cb);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => void frames.delete(id);
    const { graph, positions, modules } = fixture(N);
    edges = graph.edgeCount;
    net.data(graph).style({ nodeRadius: 3, sizeMode: "screen" }).layout({ backend: "positions", positions });
    net.enableZoom([1e-4, 1e4]);
    flush();

    const r = host.getBoundingClientRect();
    const wheel = (x: number, y: number): void => {
      host.dispatchEvent(new WheelEvent("wheel", { clientX: r.left + x, clientY: r.top + y, deltaY: -8, bubbles: true, cancelable: true }));
    };
    const mouse = (target: EventTarget, type: string, x: number, y: number): void => {
      target.dispatchEvent(new MouseEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, view: window }));
    };
    const pointer = (type: string, x: number, y: number): void => {
      host.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
    };
    const latest = (): boolean => {
      const t = zoomTransform(host);
      const v = net.drawnView;
      return v.k === t.k && v.x === t.x && v.y === t.y;
    };

    /** Time `input` (the handlers) and the one frame after it; then time `one`, the single-event reference. */
    const burst = (input: () => void, one: () => void): Burst => {
      const cuts0 = work.cuts;
      const renders0 = net.renders;
      const t0 = performance.now();
      input();
      const handlerMs = performance.now() - t0;
      const handlerCuts = work.cuts - cuts0;
      const handlerRenders = net.renders - renders0;
      const cuts1 = work.cuts;
      const renders1 = net.renders;
      const t1 = performance.now();
      flush();
      const frameMs = performance.now() - t1;
      const frameCuts = work.cuts - cuts1;
      const frameRenders = net.renders - renders1;
      const drawnIsLatest = latest();
      const t2 = performance.now();
      one();
      return { handlerMs, handlerCuts, handlerRenders, frameMs, frameCuts, frameRenders, drawnIsLatest, oneMs: performance.now() - t2 };
    };

    // The whole grid in view, centred, with a margin: every node and edge is on screen.
    const cx = ((COLS - 1) * SPACING) / 2;
    const cy = ((ROWS - 1) * SPACING) / 2;
    const k = (0.8 * Math.min(W, H)) / Math.max((COLS - 1) * SPACING, (ROWS - 1) * SPACING);
    const base: ViewTransform = { k, x: W / 2 - k * cx, y: H / 2 - k * cy };
    /** A screen point near the view centre with a drawn node glyph under it (a leaf, or an aggregate with LOD
     *  on): what the drag grabs. Searched outward from the centre, at the base view. */
    const grabPoint = (): [number, number] => {
      for (let d = 0; d < 40; d++) {
        for (let a = 0; a < 8; a++) {
          const x = W / 2 + d * Math.cos((a * Math.PI) / 4);
          const y = H / 2 + d * Math.sin((a * Math.PI) / 4);
          if (net.pick(x, y)) return [x, y];
        }
      }
      throw new Error("no node glyph near the view centre to grab");
    };

    const leg = async (lod: boolean): Promise<Leg> => {
      const bursts: Record<Kind, Burst[]> = { wheel: [], pan: [], drag: [], mixed: [] };
      for (let round = 0; round < ROUNDS; round++) {
        // Wheel: BURST ticks about the view centre; then the wheel goes idle and d3-zoom ends the gesture.
        net.setTransform(base);
        bursts.wheel.push(burst(
          () => { for (let i = 0; i < BURST; i++) wheel(W / 2 + i, H / 2); },
          () => { net.setTransform(net.drawnView); },
        ));
        await until(() => !net.gestureActive);

        // Pan: a mouse drag on the canvas, BURST moves, then the release.
        net.setTransform(base);
        mouse(host, "mousedown", W / 2, H / 2);
        bursts.pan.push(burst(
          () => { for (let i = 1; i <= BURST; i++) mouse(window, "mousemove", W / 2 - 3 * i, H / 2 + 2 * i); },
          () => { net.setTransform(net.drawnView); },
        ));
        mouse(window, "mouseup", W / 2 - 3 * BURST, H / 2 + 2 * BURST);
        flush();
      }

      // Node drag: grab a glyph near the centre. The grab (past the click slop) selects it — a click-rate
      // restyle, flushed before timing.
      net.interactive({ draggable: true, selectable: true });
      for (let round = 0; round < ROUNDS; round++) {
        net.setTransform(base);
        flush();
        const [gx, gy] = grabPoint(); // afresh: the previous round moved the glyph it grabbed
        pointer("pointerdown", gx, gy);
        pointer("pointermove", gx, gy + 6);
        flush();
        let y = gy + 6;
        bursts.drag.push(burst(
          () => { for (let i = 0; i < BURST; i++) pointer("pointermove", gx, (y += 1)); },
          () => { pointer("pointermove", gx, (y += 1)); flush(); },
        ));
        // Mixed: wheel ticks, a streamed layout frame and drag moves, all before one frame.
        bursts.mixed.push(burst(
          () => {
            for (let i = 0; i < BURST / 2; i++) wheel(W / 2, H / 2);
            net.streamFrame();
            for (let i = 0; i < BURST / 2; i++) pointer("pointermove", gx, (y += 1));
          },
          () => { net.streamFrame(); flush(); },
        ));
        pointer("pointerup", gx, y);
        flush();
        await until(() => !net.gestureActive);
      }
      net.interactive(false);
      flush();
      net.setTransform(base);
      return { lod, bursts, drawn: lod ? work.lastCut : N };
    };

    net.lod(false);
    flush();
    legs["LOD OFF"] = await leg(false);
    net.lod({ modules });
    flush();
    legs["LOD ON, aggregate frontier"] = await leg(true);
    net.lod({ modules, expandPx: 1e-6, declutter: false });
    flush();
    legs["LOD ON, all leaves"] = await leg(true);
  } finally {
    net.destroy();
    host.remove();
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
  }
}, SETUP_MS);

const best = (xs: number[]): number => Math.min(...xs);

describe(`network() input coalescing — ≤1 frontier pass per frame at ${N.toLocaleString()} nodes (#367)`, () => {
  it("reports the measured costs", () => {
    for (const [name, leg] of Object.entries(legs)) {
      for (const kind of KINDS) {
        const bs = leg.bursts[kind];
        console.log(
          `[input-coalesce] ${name} ${kind}: handlers ${best(bs.map((b) => b.handlerMs)).toFixed(2)} ms / ${BURST} events, ` +
            `frame ${best(bs.map((b) => b.frameMs)).toFixed(1)} ms vs one event's ${best(bs.map((b) => b.oneMs)).toFixed(1)} ms ` +
            `(drawn ${leg.drawn.toLocaleString()} nodes, ${edges.toLocaleString()} edges)`,
        );
      }
    }
    expect(Object.keys(legs)).toHaveLength(3);
  });

  it("non-vacuity: the fixture is ≈1M drawables, and the all-leaves frontier is every node", () => {
    expect(N + edges, "the fixture is not ≈4 drawables per node").toBeGreaterThanOrEqual(3.9 * N);
    expect(legs["LOD ON, all leaves"]?.drawn, "LOD shrank the all-leaves frontier: the guard would measure a small set").toBe(N);
    const agg = legs["LOD ON, aggregate frontier"]?.drawn ?? 0;
    expect(agg, "the aggregate leg drew every leaf: it is not the reduced case").toBeLessThan(N);
    expect(agg, "the aggregate leg drew nothing").toBeGreaterThan(0);
  });

  for (const name of ["LOD OFF", "LOD ON, aggregate frontier", "LOD ON, all leaves"]) {
    describe(name, () => {
      for (const kind of KINDS) {
        it(`${kind}: nothing is drawn inside an input handler; the frame after the burst draws once, at the latest transform`, () => {
          const leg = legs[name];
          expect(leg, "the leg did not run").toBeDefined();
          for (const b of leg?.bursts[kind] ?? []) {
            expect(b.handlerCuts, "an input handler ran an LOD cut").toBe(0);
            expect(b.handlerRenders, "an input handler rendered").toBe(0);
            expect(b.frameRenders, "the burst's frame did not render exactly once").toBe(1);
            expect(b.frameCuts, "the burst's frame did not run exactly one frontier pass").toBe(leg?.lod ? 1 : 0);
            expect(b.drawnIsLatest, "the frame drew a transform other than the latest").toBe(true);
          }
        });

        // LOD OFF pan/zoom: the frame only renders, and render() is counted here, so its clock is ~0 on both
        // sides — count-only (see the header): time the handlers, leave the frame to the count above.
        const countOnlyFrame = name === "LOD OFF" && (kind === "wheel" || kind === "pan");
        const title = countOnlyFrame
          ? `${kind}: handlers cost a constant per event (the frame is count-only: a counted render)`
          : `${kind}: handlers cost a constant per event; the burst's frame costs one pass`;
        it(title, () => {
          const bs = legs[name]?.bursts[kind] ?? [];
          expect(bs).toHaveLength(ROUNDS);
          expect(best(bs.map((b) => b.handlerMs)), "input handlers did per-event work").toBeLessThan(HANDLER_MS_PER_EVENT * BURST);
          if (countOnlyFrame) return;
          const frame = best(bs.map((b) => b.frameMs));
          const one = best(bs.map((b) => b.oneMs));
          expect(frame, "the burst's frame cost more than one pass").toBeLessThan(FRAME_RATIO * one + FRAME_SLACK_MS);
          expect(frame, "the burst's frame is over the absolute ceiling").toBeLessThan(FRAME_MS);
        });
      }
    });
  }
});
