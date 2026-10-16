import { describe, it, expect, beforeAll, vi } from "vitest";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleLink, ModuleNode } from "../modules.js";
import { NestedDrag } from "../nested-drag.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost } from "../../__tests__/engine-sweep.js";
import type { ViewTransform } from "../../core/index.js";
import { centredOn, collapsedGlyph, ringOnCentreLines, type Grab } from "./_ring-grab.js";

/**
 * ENGINE-level per-frame guard for a node-drag on a **nested** module map (docs/agents/performance.md — a drag
 * is a per-frame path). Through the real trigger: pointer events on the host grab a leaf, each animation
 * frame of the drag session runs ONE tick of the re-solved module ({@link NestedDrag}: the leaf's
 * siblings, inside its module's disc) and repaints; the release cools it, at most
 * `Network.DRAG_COOL_FRAMES` frames (the flat drag's re-cool). The node guard (`nested-drag-perf.test.ts`) pins the tick's own work
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
 *
 * Grabs (#479): a leaf (both reduction states), and under LOD ON a module three ways, each through the real
 * pointer path: by its boundary ring at a zoomed-in view (a few modules open), by its glyph once a zoom-out
 * has collapsed it (the module grab the ring grab must equal), and by a ring with every module open
 * (`expandPx` ~0, declutter off: reductions off, at the zoom that fits the map). A ring grab must re-solve
 * the same modules as the collapsed grab of its module, with the same per-frame signatures and ceilings.
 * The LOD OFF legs and the every-module-open legs (each with its translate-only baseline) COUNT `render()`
 * instead of submitting it (see {@link Probe}) and assert one render per held frame; the LOD ON zoomed-in
 * legs (leaf, ring, collapsed module) draw for real.
 */

// Max 50k, set while the LOD OFF legs drew: every drag frame (8 held, up to 90 cooling) repaints, and at
// 100k the file spent ~190 s waiting on software GL's queue of LOD-off draws (its CPU work took ~1.4 s),
// too close to the tier's 300 s per file. They now count `render()` (see Probe); the cap stays until a run
// shows the file fits at 100k. The tick's own work is pinned at 1M by the node guard.
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
/** The legs (and their baselines) that count `render()` instead of drawing (see {@link Probe}). */
const COUNTED: ReadonlySet<string> = new Set(["LOD OFF", "LOD ON ring, every module open"]);

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

/**
 * Counts `render()`, and with `countOnly` set does not submit it. The engine's `render()` only submits the
 * backend's draw: the re-solve tick, the LOD cut, the lane emit, the uploads and the GL buffer counts all
 * still run. This guard measures the drag's CPU work, so the legs whose frames draw a full-detail view set
 * it: the LOD OFF legs (the leaf drag and its translate-only baseline, while LOD is off) and the
 * every-module-open legs (the ring grab and its baseline). On the headless runner's software GL (SwiftShader)
 * the LOD OFF leaf drag's frames queued ~200 s of GPU work, and the stall surfaced in a later leg, at the
 * first call that waited on the queue (LOG.md, "Local headless Chromium rasterises on SwiftShader").
 * Those legs assert one render per held frame; network-sweep-perf.browser.test.ts owns the LOD-off
 * full-detail draw and network-module-boundary-perf.browser.test.ts the every-module-open view's. The LOD ON
 * zoomed-in legs leave it unset and draw for real.
 */
class Probe extends Network {
  renders = 0;
  countOnly = false;
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  override render(): this {
    this.renders++;
    return this.countOnly ? this : super.render();
  }
}

interface Leg {
  /** Whether the leg's frames were drawn (`false`: `render()` was counted, not submitted). */
  drawn: boolean;
  heldTicks: number[];
  /** `render()` calls per held frame. */
  heldRenders: number[];
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
  /** The tree id the pointer-down grabbed, and the modules the re-solve ran (deepest first). */
  grabbed: number;
  resolved: number[];
}

const legs: Record<string, Leg> = {};

beforeAll(async () => {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const spy = new GlBufferSpy();
  const tick = vi.spyOn(NestedDrag.prototype, "tick");
  try {
    const host = perfHost(W, H);
    const net = new Probe(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    globalThis.requestAnimationFrame = (cb) => {
      queued.set(++frameId, cb);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => void queued.delete(id);

    const { graph: g, modules, links } = fixture(N);
    let nodeFill = 0;
    net.countOnly = true; // while LOD is off (see Probe)
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
    const show = (view: ViewTransform): void => {
      net.setTransform(view);
      flush();
    };
    const at = (id: number): [number, number] => [g.positions[id * 2] ?? 0, g.positions[id * 2 + 1] ?? 0];
    /** The centroid of leaves `ids` (a module's, where a view centred on it meets its ring on both centre lines). */
    const centroid = (ids: readonly number[]): [number, number] => {
      let sx = 0, sy = 0;
      for (const i of ids) { sx += at(i)[0]; sy += at(i)[1]; }
      return [sx / ids.length, sy / ids.length];
    };
    /** A leaf grab: the leaf at the view centre, at zoom K. */
    const leafGrab = (id: number) => (): Grab => {
      const view = centredOn(...at(id), K, W, H);
      show(view);
      return { view, x: W / 2, y: H / 2, ref: id };
    };
    /** Module `mod` grabbed by its ring, at zoom `k`, centred on its leaves. */
    const ringGrab = (mod: number, members: readonly number[], k: number) => (): Grab => {
      const view = centredOn(...centroid(members), k, W, H);
      show(view);
      const ring = ringOnCentreLines(net, W, H, mod);
      if (!ring) throw new Error(`module ${mod}'s ring is not drawn at k=${k}`);
      return { view, x: ring.x, y: ring.y, ref: members[0]! };
    };
    /** Module `mod` grabbed by its glyph, zoomed out from K until it has collapsed. */
    const glyphGrab = (mod: number, members: readonly number[]) => (): Grab => {
      const glyph = collapsedGlyph(net, W, H, mod, ...centroid(members), K, show);
      if (!glyph) throw new Error(`module ${mod} never collapsed`);
      return { ...glyph, ref: members[0]! };
    };
    /** The first ring drawn on the centre lines of `view`: its module and leaves. */
    const ringIn = (view: ViewTransform): { mod: number; members: number[] } => {
      show(view);
      const ring = ringOnCentreLines(net, W, H);
      if (!ring) throw new Error("no ring drawn on the centre lines");
      return { mod: ring.hit.id as number, members: (ring.hit.members?.() ?? []) as number[] };
    };
    const leg = (grab: () => Grab, nested: boolean): Leg => {
      const { view, x: gx, y: gy, ref: id } = grab();
      const k = view.k;
      const [x0, y0] = at(id);
      const grabbed = net.pick(gx, gy)?.id as number;
      const fill0 = nodeFill;
      const calls0 = tick.mock.calls.length;
      pointer("pointerdown", gx, gy);
      pointer("pointermove", gx + 8, gy);
      const mark = spy.mark();
      const heldTicks: number[] = [];
      const heldRenders: number[] = [];
      const ts: number[] = [];
      let heldError = 0;
      let maxLeafWrites = 0;
      let writes = 0;
      // A small move (under 1 world unit): the leaf stays well inside its module's disc.
      for (let f = 1; f <= HELD_FRAMES; f++) {
        const dx = 8 - f;
        pointer("pointermove", gx + dx, gy + f / 2);
        const before = tick.mock.calls.length;
        const renders0 = net.renders;
        const t0 = performance.now();
        flush();
        ts.push(performance.now() - t0);
        heldTicks.push(tick.mock.calls.length - before);
        heldRenders.push(net.renders - renders0);
        const session = nested ? tick.mock.contexts[calls0] : undefined;
        if (session) {
          maxLeafWrites = Math.max(maxLeafWrites, session.stats.leafWrites - writes);
          writes = session.stats.leafWrites;
        }
        heldError = Math.max(heldError, Math.hypot((g.positions[id * 2] ?? 0) - (x0 + dx / k), (g.positions[id * 2 + 1] ?? 0) - (y0 + f / 2 / k)));
      }
      pointer("pointerup", gx + 8 - HELD_FRAMES, gy + HELD_FRAMES / 2);
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
        drawn: !net.countOnly,
        heldTicks,
        heldRenders,
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
        grabbed,
        resolved: drag ? drag.modules.map((m) => m.g) : [],
      };
    };

    // One nested layout for both reduction states (it does not depend on LOD), then the path it replaces:
    // the same positions, translate-only, in the reverse order.
    const offLeaf = drawnLeaf(1);
    legs["LOD OFF"] = leg(leafGrab(offLeaf), true);
    const sweepLod = { declutter: false, moduleBoundary: {} };
    const allOpenLod = { expandPx: 1e-6, declutter: false, moduleBoundary: {} };
    net.countOnly = false;
    net.lod(sweepLod);
    flush();
    const onLeaf = drawnLeaf(Math.floor(N / 2));
    legs["LOD ON"] = leg(leafGrab(onLeaf), true);
    // A module opened at the zoomed-in view, grabbed by its ring and then collapsed by its glyph.
    const near = ringIn(centredOn(...at(onLeaf), K, W, H));
    const sweepRing = ringGrab(near.mod, near.members, K);
    const sweepGlyph = glyphGrab(near.mod, near.members);
    legs["LOD ON ring"] = leg(sweepRing, true);
    legs["LOD ON module"] = leg(sweepGlyph, true);
    // Every module open, at the zoom that fits the map: grab the first ring on its centre lines.
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let i = 0; i < N; i++) {
      const [x, y] = at(i);
      x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
    }
    const kFit = 0.9 * Math.min(W / (x2 - x1), H / (y2 - y1));
    // Count-only from here to its baseline (see Probe): every leaf and ring is in view.
    net.countOnly = true;
    net.lod(allOpenLod);
    flush();
    const open = ringIn(centredOn((x1 + x2) / 2, (y1 + y2) / 2, kFit, W, H));
    const allOpenRing = ringGrab(open.mod, open.members, kFit);
    legs["LOD ON ring, every module open"] = leg(allOpenRing, true);
    // The paths they replace, translate-only, in the reverse order.
    net.layout({ backend: "positions", positions: g.positions.slice() });
    flush();
    legs["LOD ON ring, every module open translate"] = leg(allOpenRing, false);
    net.countOnly = false;
    net.lod(sweepLod);
    flush();
    legs["LOD ON module translate"] = leg(sweepGlyph, false);
    legs["LOD ON ring translate"] = leg(sweepRing, false);
    legs["LOD ON translate"] = leg(leafGrab(onLeaf), false);
    net.countOnly = true; // LOD off again (see Probe)
    net.lod(false);
    flush();
    legs["LOD OFF translate"] = leg(leafGrab(offLeaf), false);
    for (const [name, l] of Object.entries(legs)) {
      console.log(`[nested-drag-perf N=${N}] ${name} (${l.drawn ? "drawn" : "render counted"}): grabbed ${l.grabbed}, median held frame ${l.heldMedianMs.toFixed(2)} ms, held error ${l.heldError.toExponential(1)}, buffers +${l.created}/-${l.deleted}, cool ${l.coolFrames}, leaf writes ≤ ${l.maxLeafWrites}, node writes ${l.nodeWrites}`);
    }
    net.destroy();
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
    tick.mockRestore();
    spy.restore();
  }
}, SETUP_MS);

describe(`network() node-drag on a nested map — per-frame cost at N=${N.toLocaleString()}`, () => {
  for (const name of ["LOD OFF", "LOD ON", "LOD ON ring", "LOD ON module", "LOD ON ring, every module open"] as const) {
    it(`${name}: one re-solve tick per frame, the leaf held under the cursor, no buffer churn or style re-resolve`, () => {
      const leg = legs[name]!;
      expect(leg.heldTicks).toEqual(new Array<number>(HELD_FRAMES).fill(1));
      expect(leg.heldRenders, "renders per held frame").toEqual(new Array<number>(HELD_FRAMES).fill(1));
      expect(leg.drawn, "drawn for real, or render() counted (LOD OFF and every module open: see Probe)").toBe(!COUNTED.has(name));
      expect(legs[`${name} translate`]!.drawn, "the baseline drawn as its leg is").toBe(leg.drawn);
      expect(leg.heldError, "the held leaf left the cursor").toBeLessThan(1e-2);
      // As the whole map reflows the LOD frontier changes: an instanced lane may grow (it at least doubles,
      // reallocating its 8 buffers), a few times at most — never a per-frame upload of new buffers.
      expect(leg.created, "GPU buffers created by drag frames").toBeLessThanOrEqual(16);
      expect(leg.created % 8, "a buffer created outside a lane grow").toBe(0);
      expect(leg.deleted, "GPU buffers destroyed by drag frames").toBeLessThanOrEqual(leg.created);
      expect(leg.nodeFill, "nodeFill re-ran during the drag").toBe(0);
    });

    it(`${name}: a tick writes each moved leaf once${name !== "LOD OFF" ? ", and translates the module tree's geometry in place" : ""}`, () => {
      const leg = legs[name]!;
      expect(leg.leavesUnder).toBeGreaterThan(0);
      expect(leg.maxLeafWrites).toBeGreaterThan(0);
      expect(leg.maxLeafWrites).toBeLessThanOrEqual(N);
      if (name !== "LOD OFF") expect(leg.nodeWrites, "the module tree's geometry was not translated in place").toBeGreaterThan(0);
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

  it("a ring grab is the module grab: the pointer-down grabs the module's tree id and re-solves what its collapsed grab does (#479)", () => {
    const ring = legs["LOD ON ring"]!;
    const shut = legs["LOD ON module"]!;
    const open = legs["LOD ON ring, every module open"]!;
    expect(ring.grabbed).toBe(shut.grabbed);
    expect(ring.grabbed, "a module, not a leaf").toBeGreaterThanOrEqual(N);
    expect(open.grabbed).toBeGreaterThanOrEqual(N);
    expect(ring.resolved.length, "the ring grab re-solved nothing").toBeGreaterThan(0);
    expect(ring.resolved).toEqual(shut.resolved);
    for (const name of ["LOD ON ring", "LOD ON module", "LOD ON ring, every module open"]) expect(legs[`${name} translate`]!.grabbed, name).toBe(legs[name]!.grabbed);
  });
});
