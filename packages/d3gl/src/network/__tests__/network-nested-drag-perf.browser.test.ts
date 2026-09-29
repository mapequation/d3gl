import { describe, it, expect, beforeAll, vi } from "vitest";
import { network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleLink, ModuleNode } from "../modules.js";
import { NestedDrag } from "../nested-drag.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost } from "../../__tests__/engine-sweep.js";

/**
 * ENGINE-level per-frame guard for a node-drag on a **nested** module map (AGENTS.md lifecycle §5 — a drag
 * is a per-frame path). Through the real trigger: pointer events on the host grab a leaf, each animation
 * frame of the drag session runs ONE tick of the re-solved module ({@link NestedDrag}: the leaf's
 * siblings, inside its module's disc) and repaints; the release cools it, at most
 * `NESTED_DRAG_COOL_TICKS` frames. The node guard (`nested-drag-perf.test.ts`) pins the tick's own work
 * at 1M leaves (leaf, bottom-module and top-module grabs).
 *
 * Frames are stepped by hand (`requestAnimationFrame` replaced by a queue this file flushes). Both
 * reduction states on ONE engine (#287): LOD OFF (the whole graph re-emitted per frame) and LOD ON with
 * the module rings (the module tree's geometry translated in place per frame). Each leg is measured
 * against the **path it replaces**, on the same engine, map and leaf: the translate-only drag (the same
 * positions under `layout({ backend: "positions" })`).
 *
 * Signatures: exactly one re-solve tick per animation frame while held and while cooling; the loop stops
 * within the cool budget and ticks nothing after; the held leaf exactly under the cursor; per tick, only
 * leaves under the re-solved module written; under LOD ON its geometry translated in place (no
 * `computeLODPositions` over the tree); no GPU buffer created or destroyed and `nodeFill` never re-run by
 * a drag frame.
 */

// Max 50k: every drag frame (8 held, up to 90 cooling, per nested leg) repaints, and on software GL a
// LOD-off frame's draw queues behind the last — at 100k the file spent ~190 s waiting on the GPU queue
// (its CPU work took ~1.4 s), too close to the tier's 300 s per file. The tick's own work is pinned at
// 1M by the node guard, and the draw is the translate-only drag's, measured against it here.
const N = perfN(50_000, { max: 50_000 });
const W = 640;
const H = 400;
const HELD_FRAMES = 8;
const COOL_TICKS = 90;
const SETUP_MS = perfBudget(120_000 + N);
// A held frame against the translate-only drag's frame on the same engine: both draw the same frame (the
// drag's re-solve of ~16-96 siblings is microseconds). Ratio + a constant for timer noise.
const VS_TRANSLATE = 1.5;
const VS_TRANSLATE_MS = perfBudget(4);

/** An `.ftree`-shaped map: modules of 2-12 children down to 16-96-leaf bottom modules (as the module-boundary guard's). */
function fixture(n: number): { graph: NetworkGraph; modules: ModuleNode[]; links: ModuleLink[] } {
  let s = 17 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const modules: ModuleNode[] = new Array<ModuleNode>(n);
  const source: number[] = [];
  const target: number[] = [];
  const links: ModuleLink[] = [];
  const place = (lo: number, hi: number, prefix: number[]): void => {
    const size = hi - lo;
    if (prefix.length >= 1 && (prefix.length >= 7 || size <= 16 + rng() * 80)) {
      for (let i = lo; i < hi; i++) {
        modules[i] = { id: i, path: [...prefix, i - lo + 1] };
        source.push(i, i);
        target.push(lo + Math.floor(rng() * size), lo + Math.floor(rng() * size));
      }
      return;
    }
    const k = Math.min(2 + Math.floor(rng() * 11), size);
    let start = lo;
    for (let j = 0; j < k; j++) {
      const end = j === k - 1 ? hi : Math.min(hi - (k - 1 - j), Math.max(start + 1, lo + Math.round((size * (j + 1)) / k)));
      place(start, end, [...prefix, j + 1]);
      start = end;
      for (let e = 0; e < 2; e++) {
        const o = Math.floor(rng() * k);
        if (o !== j) links.push({ source: [...prefix, j + 1], target: [...prefix, o + 1], flow: 1 + rng() * 9 });
      }
    }
  };
  place(0, n, []);
  return { graph: buildGraph({ nodeCount: n, source, target, directed: true }), modules, links };
}

const queued = new Map<number, FrameRequestCallback>();
let frameId = 0;
function flush(): void {
  const due = [...queued.values()];
  queued.clear();
  const now = performance.now();
  for (const cb of due) cb(now);
}

interface Leg {
  heldTicks: number[];
  heldMedianMs: number;
  heldError: number;
  coolFrames: number;
  ticksAfterStop: number;
  created: number;
  deleted: number;
  nodeFill: number;
  /** Most leaves one tick wrote, and the leaves under the re-solved module. */
  maxLeafWrites: number;
  leavesUnder: number;
  nodeWrites: number;
}

const legs: Record<string, Leg> = {};

beforeAll(async () => {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const spy = new GlBufferSpy();
  const tick = vi.spyOn(NestedDrag.prototype, "tick");
  try {
    const host = perfHost(W, H);
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    globalThis.requestAnimationFrame = (cb) => {
      queued.set(++frameId, cb);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => void queued.delete(id);

    const { graph: g, modules, links } = fixture(N);
    let nodeFill = 0;
    net
      .data(g, { modules, moduleLinks: links })
      .style({ nodeRadius: 3, sizeMode: "screen", nodeFill: (i) => (nodeFill++, i % 2 ? "rgb(59,130,246)" : "rgb(245,158,11)") })
      .lod(false)
      .layout({ backend: "force", nested: { iterations: 20 } }); // synchronous
    net.interactive({ draggable: true });
    flush();

    const rect = host.getBoundingClientRect();
    const pointer = (type: string, x: number, y: number): void => {
      host.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, button: 0, pointerId: 1 }));
    };
    const K = 8;
    /** A leaf drawn (and picked) at the view centre at zoom K, from `from` on. */
    const drawnLeaf = (from: number): number => {
      for (let id = from; id < N; id += 97) {
        net.setTransform({ k: K, x: W / 2 - (g.positions[id * 2] ?? 0) * K, y: H / 2 - (g.positions[id * 2 + 1] ?? 0) * K });
        flush();
        if (net.pick(W / 2, H / 2)?.id === id) return id;
      }
      throw new Error("no drawn leaf");
    };
    const leg = (id: number, nested: boolean): Leg => {
      const x0 = g.positions[id * 2] ?? 0;
      const y0 = g.positions[id * 2 + 1] ?? 0;
      net.setTransform({ k: K, x: W / 2 - x0 * K, y: H / 2 - y0 * K });
      flush();
      const fill0 = nodeFill;
      const calls0 = tick.mock.calls.length;
      pointer("pointerdown", W / 2, H / 2);
      pointer("pointermove", W / 2 + 8, H / 2);
      const mark = spy.mark();
      const heldTicks: number[] = [];
      const ts: number[] = [];
      let heldError = 0;
      let maxLeafWrites = 0;
      let writes = 0;
      // A small move (under 1 world unit): the leaf stays well inside its module's disc.
      for (let f = 1; f <= HELD_FRAMES; f++) {
        const dx = 8 - f;
        pointer("pointermove", W / 2 + dx, H / 2 + f / 2);
        const before = tick.mock.calls.length;
        const t0 = performance.now();
        flush();
        ts.push(performance.now() - t0);
        heldTicks.push(tick.mock.calls.length - before);
        const session = nested ? tick.mock.contexts[calls0] : undefined;
        if (session) {
          maxLeafWrites = Math.max(maxLeafWrites, session.stats.leafWrites - writes);
          writes = session.stats.leafWrites;
        }
        heldError = Math.max(heldError, Math.hypot((g.positions[id * 2] ?? 0) - (x0 + dx / K), (g.positions[id * 2 + 1] ?? 0) - (y0 + f / 2 / K)));
      }
      pointer("pointerup", W / 2 + 8 - HELD_FRAMES, H / 2 + HELD_FRAMES / 2);
      let coolFrames = 0;
      for (let f = 0; f < 3 * COOL_TICKS; f++) {
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
      const drag = nested ? tick.mock.contexts[calls0] : undefined;
      // The leaves under the held leaf's module (the deepest re-solve): all a tick inside it may write.
      const leavesUnder = drag ? Array.from(drag.modules[0]!.cnt).reduce((a, b) => a + b, 0) : 0;
      return {
        heldTicks,
        heldMedianMs: ts[Math.floor(ts.length / 2)] ?? Infinity,
        heldError,
        coolFrames,
        ticksAfterStop: tick.mock.calls.length - stopped,
        created: used.created,
        deleted: used.deleted,
        nodeFill: nodeFill - fill0,
        maxLeafWrites,
        leavesUnder,
        nodeWrites: drag ? drag.stats.nodeWrites : 0,
      };
    };

    // One nested layout for both reduction states (it does not depend on LOD), then the path it replaces:
    // the same positions, translate-only, in the reverse order.
    const offLeaf = drawnLeaf(1);
    legs["LOD OFF"] = leg(offLeaf, true);
    net.lod({ declutter: false, moduleBoundary: {} });
    flush();
    const onLeaf = drawnLeaf(Math.floor(N / 2));
    legs["LOD ON"] = leg(onLeaf, true);
    net.layout({ backend: "positions", positions: g.positions.slice() });
    flush();
    legs["LOD ON translate"] = leg(onLeaf, false);
    net.lod(false);
    flush();
    legs["LOD OFF translate"] = leg(offLeaf, false);
    net.destroy();
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
    tick.mockRestore();
    spy.restore();
  }
}, SETUP_MS);

describe(`network() node-drag on a nested map — per-frame cost at N=${N.toLocaleString()}`, () => {
  for (const name of ["LOD OFF", "LOD ON"] as const) {
    it(`${name}: one re-solve tick per frame, the leaf held under the cursor, no buffer churn or style re-resolve`, () => {
      const leg = legs[name]!;
      expect(leg.heldTicks).toEqual(new Array<number>(HELD_FRAMES).fill(1));
      expect(leg.heldError, "the held leaf left the cursor").toBeLessThan(1e-2);
      expect(leg.created, "GPU buffers created by drag frames").toBe(0);
      expect(leg.deleted, "GPU buffers destroyed by drag frames").toBe(0);
      expect(leg.nodeFill, "nodeFill re-ran during the drag").toBe(0);
    });

    it(`${name}: a tick writes only the leaves under the re-solved module${name === "LOD ON" ? ", and translates its geometry in place" : ""}`, () => {
      const leg = legs[name]!;
      expect(leg.leavesUnder).toBeGreaterThan(0);
      expect(leg.leavesUnder).toBeLessThan(N / 20);
      expect(leg.maxLeafWrites).toBeLessThanOrEqual(leg.leavesUnder);
      if (name === "LOD ON") expect(leg.nodeWrites, "the module tree's geometry was not translated in place").toBeGreaterThan(0);
      else expect(leg.nodeWrites).toBe(0);
    });

    it(`${name}: the release cools and stops within its budget`, () => {
      const leg = legs[name]!;
      expect(leg.coolFrames, "the cool-down never ran").toBeGreaterThan(0);
      expect(leg.coolFrames).toBeLessThanOrEqual(COOL_TICKS);
      expect(leg.ticksAfterStop, "the loop kept ticking after it stopped").toBe(0);
    });

    it(`${name}: a held frame costs about what the translate-only drag's does`, () => {
      const leg = legs[name]!;
      const base = legs[`${name} translate`]!;
      expect(base.heldTicks.every((t) => t === 0), "the baseline ran a re-solve").toBe(true);
      const ceiling = VS_TRANSLATE * base.heldMedianMs + VS_TRANSLATE_MS;
      expect(leg.heldMedianMs, `${name}: median held frame ${leg.heldMedianMs.toFixed(2)} ms vs translate-only ${base.heldMedianMs.toFixed(2)} ms`).toBeLessThan(ceiling);
    });
  }
});
