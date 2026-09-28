import { describe, it, expect, beforeAll, vi } from "vitest";
import { network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { ForceLayout } from "../force.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost } from "../../__tests__/engine-sweep.js";

/**
 * ENGINE-level per-frame guard for a node-drag on the main-thread force backend (`layout({ backend:
 * "force" })`, AGENTS.md lifecycle §5 — a drag is a per-frame path). Through the real trigger: pointer
 * events on the host grab a node, each animation frame of the drag session holds it under the cursor,
 * runs ONE `ForceLayout.tick` over all N nodes (LOD and declutter do not reduce it) and repaints; the
 * release re-cools at the drag heat until converged, at most `DRAG_COOL_FRAMES` frames. The node guard
 * (`force-drag-tick-perf.test.ts`) pins the tick's own work (one Barnes-Hut build, N traversals) at 100k–1M.
 *
 * Frames are stepped by hand: `requestAnimationFrame` is replaced by a queue this file flushes, so each
 * drag frame runs — and is timed — alone. Both reduction states on ONE engine (#287): LOD OFF (the whole
 * graph re-emitted per frame) and LOD ON (the structural tree's position pass per frame).
 *
 * Signatures: exactly one tick per animation frame while held and while re-cooling; the loop stops within
 * the re-cool budget after release (and ticks nothing after); the held node exactly under the cursor; no
 * GPU buffer created or destroyed and `nodeFill` (resolved at registration) never re-run by a drag frame.
 */

const N = perfN(50_000, { max: 200_000 });
const W = 640;
const H = 400;
const HELD_FRAMES = 8;
/** `Network.DRAG_COOL_FRAMES`: the release's re-cool budget (it stops earlier once converged). */
const DRAG_COOL_FRAMES = 90;
const SETUP_MS = perfBudget(60_000 + N / 2);
// Measured (local headless Chromium, median held frame, shared machine at load ~12): at 50k, 57 ms with
// LOD OFF and ON alike — almost all of it the O(N log N) tick; the release re-cool converged after 30
// frames (the earliest a schedule may stop). The ceiling is ~3.5× that: an order-of-magnitude drop (a
// full-graph style pass or layout per frame) lands far above it, while a second tick per frame is caught
// exactly by the tick count, not the clock. Constant + linear split per AGENTS (the tick grows as
// N log N; the linear term covers it over the leg's 4× range).
const FRAME_MS = perfBudget(40 + (160 * N) / 50_000);

/** Ring backbone + deterministic short-range chords: N nodes, 2N edges, clustered like a real network. */
function fixture(n: number): NetworkGraph {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source = new Uint32Array(2 * n);
  const target = new Uint32Array(2 * n);
  for (let i = 0; i < n; i++) {
    source[2 * i] = i;
    target[2 * i] = (i + 1) % n;
    source[2 * i + 1] = i;
    target[2 * i + 1] = (i + 2 + Math.floor(rng() * 48)) % n;
  }
  return buildGraph({ nodeCount: n, source, target, directed: false });
}

/** The frame queue that stands in for `requestAnimationFrame` for the whole file. */
const queued = new Map<number, FrameRequestCallback>();
let frameId = 0;
function flush(): void {
  const due = [...queued.values()];
  queued.clear();
  const now = performance.now();
  for (const cb of due) cb(now);
}

interface Leg {
  /** Ticks each held frame ran. */
  heldTicks: number[];
  heldMedianMs: number;
  /** Worst distance of the held node from where the cursor put it, over the held frames. */
  heldError: number;
  /** Frames the loop ticked after release, and ticks left once it had stopped. */
  coolFrames: number;
  ticksAfterStop: number;
  created: number;
  deleted: number;
  nodeFill: number;
}

let off: Leg;
let on: Leg;

beforeAll(async () => {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const spy = new GlBufferSpy();
  const tick = vi.spyOn(ForceLayout.prototype, "tick");
  try {
    const host = perfHost(W, H);
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    globalThis.requestAnimationFrame = (cb) => {
      queued.set(++frameId, cb);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => void queued.delete(id);

    const g = fixture(N);
    let nodeFill = 0;
    net
      .data(g)
      .style({ nodeRadius: 4, nodeFill: (i) => (nodeFill++, i % 2 ? "rgb(59,130,246)" : "rgb(245,158,11)") })
      .lod(false)
      .layout({ backend: "force" }); // synchronous: multilevel seed + refinement until converged
    net.interactive({ draggable: true });
    flush();

    const rect = host.getBoundingClientRect();
    const pointer = (type: string, x: number, y: number): void => {
      host.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, button: 0, pointerId: 1 }));
    };

    /** Grab node `id` at the view centre, zoomed in so it is a drawn leaf under either reduction state
     *  (the equilibrium spacing is ~56 world units: K·56 px apart), drag it for HELD_FRAMES frames, release. */
    const K = 4;
    const leg = (id: number): Leg => {
      const x0 = g.positions[id * 2] ?? 0;
      const y0 = g.positions[id * 2 + 1] ?? 0;
      net.setTransform({ k: K, x: W / 2 - x0 * K, y: H / 2 - y0 * K });
      flush();
      const fill0 = nodeFill;
      pointer("pointerdown", W / 2, H / 2);
      pointer("pointermove", W / 2 + 8, H / 2); // past the click slop: the drag session starts
      const mark = spy.mark();
      const heldTicks: number[] = [];
      const ts: number[] = [];
      let heldError = 0;
      for (let f = 1; f <= HELD_FRAMES; f++) {
        const dx = 8 + 6 * f;
        pointer("pointermove", W / 2 + dx, H / 2 - f);
        const before = tick.mock.calls.length;
        const t0 = performance.now();
        flush();
        ts.push(performance.now() - t0);
        heldTicks.push(tick.mock.calls.length - before);
        heldError = Math.max(heldError, Math.hypot((g.positions[id * 2] ?? 0) - (x0 + dx / K), (g.positions[id * 2 + 1] ?? 0) - (y0 - f / K)));
      }
      pointer("pointerup", W / 2 + 8 + 6 * HELD_FRAMES, H / 2 - HELD_FRAMES);
      let coolFrames = 0;
      for (let f = 0; f < 3 * DRAG_COOL_FRAMES; f++) {
        const before = tick.mock.calls.length;
        flush();
        const ran = tick.mock.calls.length - before;
        if (ran === 0) break;
        coolFrames += ran;
      }
      const stopped = tick.mock.calls.length;
      for (let f = 0; f < 10; f++) flush();
      const used = spy.since(mark);
      ts.sort((a, b) => a - b);
      return {
        heldTicks,
        heldMedianMs: ts[Math.floor(ts.length / 2)] ?? Infinity,
        heldError,
        coolFrames,
        ticksAfterStop: tick.mock.calls.length - stopped,
        created: used.created,
        deleted: used.deleted,
        nodeFill: nodeFill - fill0,
      };
    };

    off = leg(0);
    net.lod({}); // the structural tree: a registration event, then the same drag
    flush();
    on = leg(Math.floor(N / 2));
    net.destroy();
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
    tick.mockRestore();
    spy.restore();
  }
}, SETUP_MS);

describe(`network() node-drag on the main-thread force backend — per-frame cost at N=${N.toLocaleString()}`, () => {
  for (const [name, get] of [["LOD OFF", () => off], ["LOD ON", () => on]] as const) {
    it(`${name}: one tick per frame, the node held under the cursor, no buffer churn or style re-resolve`, () => {
      const leg = get();
      expect(leg.heldTicks).toEqual(new Array<number>(HELD_FRAMES).fill(1));
      expect(leg.heldError, "the held node left the cursor").toBeLessThan(1e-2);
      expect(leg.created, "GPU buffers created by drag frames").toBe(0);
      expect(leg.deleted, "GPU buffers destroyed by drag frames").toBe(0);
      expect(leg.nodeFill, "nodeFill re-ran during the drag").toBe(0);
    });

    it(`${name}: the release re-cools and stops within its budget`, () => {
      const leg = get();
      expect(leg.coolFrames, "the re-cool never ran").toBeGreaterThan(0);
      expect(leg.coolFrames).toBeLessThanOrEqual(DRAG_COOL_FRAMES);
      expect(leg.ticksAfterStop, "the loop kept ticking after it stopped").toBe(0);
    });

    it(`${name}: a held drag frame stays within budget`, () => {
      const leg = get();
      expect(leg.heldMedianMs, `${name}: median held frame ${leg.heldMedianMs.toFixed(1)} ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS);
    });
  }
});
