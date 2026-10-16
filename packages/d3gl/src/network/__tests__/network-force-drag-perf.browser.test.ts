import { describe, it, expect, beforeAll, vi } from "vitest";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { ForceLayout } from "../force.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost } from "../../__tests__/engine-sweep.js";
import type { ModuleNode } from "../modules.js";
import type { ViewTransform } from "../../core/index.js";
import { centredOn, collapsedGlyph, ringOnCentreLines, type Grab } from "./_ring-grab.js";

/**
 * ENGINE-level per-frame guard for a node-drag on the main-thread force backend (`layout({ backend:
 * "force" })`, docs/agents/performance.md — a drag is a per-frame path). Through the real trigger: pointer
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
 *
 * Module grabs (#479): the same engine then takes a module map of the same graph (consecutive blocks, which
 * the backbone keeps together) with `lod({ moduleBoundary })`, and drags a module three ways through the real
 * pointer path: by its boundary ring (a few modules open), by its glyph once a zoom-out has collapsed it, and
 * by a ring with every module open (`expandPx` ~0, declutter off: reductions off, at the zoom that fits the
 * map). The ring grab must pin exactly the leaves the collapsed grab pins, with the same signatures and ceiling.
 * Every drag must create and destroy no GPU buffer. Only the collapsed-module leg first runs the same drag once,
 * unmeasured: a force drag reflows the whole map, so the LOD lanes' frontier moves, and the collapsed grab's
 * first drag at its zoomed-out view grows an instanced layer once (+8/−8 buffers, a reallocation at a larger
 * capacity). Its measured drag passes through a frame with no collapsed glyph in view, so the aggregate-outline
 * halo layer empties there; it must keep its buffers (#482: it was dropped, −9). The ring leg and the every-module-open leg create and destroy none without a warm-up, and
 * the every-module-open leg cannot take one: at the fit zoom the drag moves the module ~2,000 world units, so
 * its ring no longer crosses the view's centre lines, where the grab looks for it. The every-module-open leg
 * COUNTS `render()` instead of submitting it (see {@link Probe}) and asserts one render per held frame; every
 * other leg draws for real.
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
// exactly by the tick count, not the clock. Constant + linear split per LOG.md (the tick grows as
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

/** Three levels of consecutive blocks: 4096-leaf top modules of 64-leaf bottom modules. */
function blockModules(n: number): ModuleNode[] {
  const out: ModuleNode[] = [];
  for (let i = 0; i < n; i++) out.push({ id: i, path: [Math.floor(i / 4096) + 1, Math.floor((i % 4096) / 64) + 1, (i % 64) + 1] });
  return out;
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

/**
 * Counts `render()`, and with `countOnly` set does not submit it. The engine's `render()` only submits the
 * backend's draw: the tick, the LOD cut, the lane emit, the uploads and the GL buffer counts all still run.
 * This guard measures the drag's CPU work, so the every-module-open leg sets it: at the zoom that fits the
 * map its frames draw every leaf and ring, GPU work that software GL (SwiftShader) queues behind each other
 * (LOG.md, "Local headless Chromium rasterises on SwiftShader"). That leg asserts one render per held
 * frame; network-module-boundary-perf.browser.test.ts owns the real draw of that view (every module open).
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
  /** Ticks each held frame ran, and `render()` calls per held frame. */
  heldTicks: number[];
  heldRenders: number[];
  heldMedianMs: number;
  /** Worst distance of the held node from where the cursor put it, over the held frames. */
  heldError: number;
  /** Frames the loop ticked after release, and ticks left once it had stopped. */
  coolFrames: number;
  ticksAfterStop: number;
  created: number;
  deleted: number;
  nodeFill: number;
  /** The tree id the pointer-down grabbed, and the leaves the drag pinned (sorted). */
  grabbed: number;
  pinned: number[];
  /** The unmeasured warm-up drag run just before this one (module-map legs). */
  warmUp?: Leg;
}

let off: Leg;
let on: Leg;
const modular: Record<string, Leg> = {};

beforeAll(async () => {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const spy = new GlBufferSpy();
  const tick = vi.spyOn(ForceLayout.prototype, "tick");
  const setPinned = vi.spyOn(ForceLayout.prototype, "setPinned");
  try {
    const host = perfHost(W, H);
    const net = new Probe(host, { width: W, height: H, backend: "webgl" });
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
    const show = (view: ViewTransform): void => {
      net.setTransform(view);
      flush();
    };
    const at = (id: number): [number, number] => [g.positions[id * 2] ?? 0, g.positions[id * 2 + 1] ?? 0];
    const centroid = (ids: readonly number[]): [number, number] => {
      let sx = 0, sy = 0;
      for (const i of ids) { sx += at(i)[0]; sy += at(i)[1]; }
      return [sx / ids.length, sy / ids.length];
    };
    const leafGrab = (id: number) => (): Grab => {
      const view = centredOn(...at(id), K, W, H);
      show(view);
      return { view, x: W / 2, y: H / 2, ref: id };
    };
    const ringGrab = (mod: number, members: readonly number[], k: number) => (): Grab => {
      const view = centredOn(...centroid(members), k, W, H);
      show(view);
      const ring = ringOnCentreLines(net, W, H, mod);
      if (!ring) throw new Error(`module ${mod}'s ring is not drawn at k=${k}`);
      return { view, x: ring.x, y: ring.y, ref: members[0]! };
    };
    const glyphGrab = (mod: number, members: readonly number[], k: number) => (): Grab => {
      const glyph = collapsedGlyph(net, W, H, mod, ...centroid(members), k, show);
      if (!glyph) throw new Error(`module ${mod} never collapsed`);
      return { ...glyph, ref: members[0]! };
    };
    const ringIn = (view: ViewTransform): { mod: number; members: number[] } => {
      show(view);
      const ring = ringOnCentreLines(net, W, H);
      if (!ring) throw new Error("no ring drawn on the centre lines");
      return { mod: ring.hit.id as number, members: (ring.hit.members?.() ?? []) as number[] };
    };
    /** One drag of `grab`; with `warm`, the same drag runs once first, unmeasured (see the file doc). */
    const leg = (grab: () => Grab, warm = false): Leg => {
      const warmUp = warm ? leg(grab) : undefined;
      const { view, x: gx, y: gy, ref: id } = grab();
      const k = view.k;
      const [x0, y0] = at(id);
      const grabbed = net.pick(gx, gy)?.id as number;
      const fill0 = nodeFill;
      const pins0 = setPinned.mock.calls.length;
      pointer("pointerdown", gx, gy);
      pointer("pointermove", gx + 8, gy); // past the click slop: the drag session starts
      const mark = spy.mark();
      const heldTicks: number[] = [];
      const heldRenders: number[] = [];
      const ts: number[] = [];
      let heldError = 0;
      for (let f = 1; f <= HELD_FRAMES; f++) {
        const dx = 8 + 6 * f;
        pointer("pointermove", gx + dx, gy - f);
        const before = tick.mock.calls.length;
        const renders0 = net.renders;
        const t0 = performance.now();
        flush();
        ts.push(performance.now() - t0);
        heldTicks.push(tick.mock.calls.length - before);
        heldRenders.push(net.renders - renders0);
        heldError = Math.max(heldError, Math.hypot((g.positions[id * 2] ?? 0) - (x0 + dx / k), (g.positions[id * 2 + 1] ?? 0) - (y0 - f / k)));
      }
      pointer("pointerup", gx + 8 + 6 * HELD_FRAMES, gy - HELD_FRAMES);
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
        grabbed,
        pinned: Array.from(setPinned.mock.calls[pins0]?.[0] ?? []).sort((a, b) => a - b),
        warmUp,
      };
    };

    off = leg(leafGrab(0));
    net.lod({}); // the structural tree: a registration event, then the same drag
    flush();
    on = leg(leafGrab(Math.floor(N / 2)));
    // #479: a module map of the same graph and positions, its rings on. A 64-leaf bottom module spans ~450
    // world units at the equilibrium spacing: ~110 px at K_RING, so its ring fits in the view.
    const K_RING = 0.25;
    net.data(g, { modules: blockModules(N) }).lod({ declutter: false, moduleBoundary: {} });
    flush();
    const near = ringIn(centredOn(...at(Math.floor(N / 3)), K_RING, W, H));
    modular["LOD ON ring"] = leg(ringGrab(near.mod, near.members, K_RING));
    modular["LOD ON module"] = leg(glyphGrab(near.mod, near.members, K_RING), true);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let i = 0; i < N; i++) {
      const [x, y] = at(i);
      x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
    }
    const kFit = 0.9 * Math.min(W / (x2 - x1), H / (y2 - y1));
    // Count-only (see Probe): every leaf and ring is in view.
    net.countOnly = true;
    net.lod({ expandPx: 1e-6, declutter: false, moduleBoundary: {} });
    flush();
    const open = ringIn(centredOn((x1 + x2) / 2, (y1 + y2) / 2, kFit, W, H));
    modular["LOD ON ring, every module open"] = leg(ringGrab(open.mod, open.members, kFit));
    net.countOnly = false;
    for (const [name, l] of Object.entries({ "LOD OFF": off, "LOD ON": on, ...modular })) {
      const warm = l.warmUp ? ` (warm-up drag: +${l.warmUp.created}/-${l.warmUp.deleted})` : "";
      console.log(`[force-drag-perf N=${N}] ${name} (${l.drawn ? "drawn" : "render counted"}): grabbed ${l.grabbed}, pinned ${l.pinned.length}, median held frame ${l.heldMedianMs.toFixed(1)} ms, held error ${l.heldError.toExponential(1)}, buffers +${l.created}/-${l.deleted}${warm}, cool ${l.coolFrames}`);
    }
    net.destroy();
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
    tick.mockRestore();
    setPinned.mockRestore();
    spy.restore();
  }
}, SETUP_MS);

describe(`network() node-drag on the main-thread force backend — per-frame cost at N=${N.toLocaleString()}`, () => {
  for (const [name, get] of [
    ["LOD OFF", () => off],
    ["LOD ON", () => on],
    ["LOD ON ring", () => modular["LOD ON ring"]!],
    ["LOD ON module", () => modular["LOD ON module"]!],
    ["LOD ON ring, every module open", () => modular["LOD ON ring, every module open"]!],
  ] as const) {
    it(`${name}: one tick per frame, the node held under the cursor, no buffer churn or style re-resolve`, () => {
      const leg = get();
      expect(leg.heldTicks).toEqual(new Array<number>(HELD_FRAMES).fill(1));
      expect(leg.heldRenders, "renders per held frame").toEqual(new Array<number>(HELD_FRAMES).fill(1));
      expect(leg.drawn, "drawn for real, or render() counted (every module open: see Probe)").toBe(name !== "LOD ON ring, every module open");
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

  it("a ring grab pins exactly the leaves its module's collapsed grab pins (#479)", () => {
    const ring = modular["LOD ON ring"]!;
    const shut = modular["LOD ON module"]!;
    expect(ring.grabbed).toBe(shut.grabbed);
    expect(ring.grabbed, "a module, not a leaf").toBeGreaterThanOrEqual(N);
    expect(ring.pinned.length, "a bottom module's leaves").toBeGreaterThan(1);
    expect(ring.pinned).toEqual(shut.pinned);
    expect(modular["LOD ON ring, every module open"]!.pinned.length).toBeGreaterThan(1);
  });
});
