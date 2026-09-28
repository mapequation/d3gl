/**
 * T7 — the streaming GPU layout's per-frame guard (#352, spec §13), run as three files: one per reduction
 * state and one for the seeded LOD run (`gpu-stream-nolod-perf.browser.test.ts`,
 * `gpu-stream-lod-perf.browser.test.ts`, `gpu-stream-seed-perf.browser.test.ts`; see {@link StreamPart}),
 * through the real trigger:
 * `network().data(g).lod(…).layout({ backend: "gpu" })`, real animation frames, one engine per reduction
 * state (LOD off; the Navigator's structural LOD on).
 *
 * Before #352 every streamed frame ran a synchronous `readPixels` after queueing a batch of ticks, so the
 * main thread waited for the whole batch: on web-NotreDame (325k nodes, M1 Max) animation-frame tasks of
 * 45 ms on average and up to 366 ms, 97% of the run in long tasks, about 11 frames per second. A node drag
 * ran 3 ticks and a synchronous read per frame. Now a frame polls fences, harvests a copy the GPU finished
 * earlier, repaints (throttled), and encodes a budgeted slice of ticks — for the initial run and for a
 * drag's reheat and re-cool alike. Pinned here:
 *
 * - **Transport-only main thread per frame** (fence polls + harvest + encode + copy + fence, the
 *   repaint excluded) below a ceiling split into constant and linear terms, and the encode part within
 *   the controller's 2 ms cap (N-independent). A reintroduced synchronous read waits for the queued GPU
 *   work and trips it.
 * - **Deterministic signatures:** every `readPixels` on the streaming path lands in a bound PBO (a numeric
 *   offset, never a CPU array); every `getBufferSubData` comes after a fence inserted after the last copy
 *   has been seen signalled; within each frame the harvest precedes every layout draw; exactly one fence
 *   per frame; no GPU object created per frame once the stream runs (under LOD, once the cut first
 *   draws), except an instanced lane outgrowing its buffers, which at least doubles them; repaints at
 *   least `minFrameMs` (50 ms) apart; `settled` resolves only after the final tick's positions were
 *   harvested.
 * - **Throughput:** ticks/s under rendering, reported and floored against the GPU-only tick rate
 *   measured in the same file (a separate solver, before the stream). The GPU-only rate is also reported
 *   with the tick cut into the static band counts of a 60 Hz and a 120 Hz budget, with the main-thread
 *   encode time per tick, so the cost of band slicing reads apart from the budget share.
 *
 * **The multilevel seed** (#353) runs first — `layout({ backend: "gpu" })` seeds from the graph's coarsening
 * by default — as budgeted work items of the same loop, so its frames carry the same transport bounds and GL
 * signatures. It is streamed with LOD off and, in a leg of its own, with LOD on (the Navigator's config: the
 * plan comes from the LOD relay's worker, and the tree is adopted while the seed runs). Pinned on top: the
 * first frame harvested is the seed frame (tick 0); no seed frame creates a GPU object (the seed's textures
 * are created once, in `beginSeed`, when the plan arrives, outside the frame loop); `beginSeed` itself stays
 * within a few ms, so a compile of a program the page has not built yet trips it (122 ms on an M1 Max; luma
 * reuses a program built earlier, so the deterministic guard is the fresh-device compile spy in
 * `gpu-multilevel-seed.browser.test.ts`); and no seed frame exceeds a max transport ceiling. The disc-start LOD-on leg (`multilevel: false`) keeps the baseline
 * comparison below like for like.
 *
 * The LOD-on leg (#377) streams through the LOD worker: it builds the tree and refits it to each harvested
 * frame, and the frame is painted with its geometry once the worker replies, so the main thread builds and
 * refits nothing (the call counts are pinned in `gpu-lod-mainthread.browser.test.ts`). Its main-thread ms
 * per layout repaint — putting the frame on the graph plus the engine's repaint — is compared against the
 * **worker backend's** on the same engine, graph and view (AGENTS lifecycle §5: the baseline the GPU path
 * must not exceed), both from a disc cold start, and asserted within a stated margin of it. Both legs assert
 * the same transport signatures.
 *
 * **Node drag** (AGENTS §5: a drag is a per-frame path), through the real trigger — pointer events on the
 * host grab a node of the settled layout, move it one step per animation frame, and release it — with LOD
 * off and on: the same transport bounds and GL signatures over the held frames and the re-cool frames after
 * release, no GPU object created, the drag's pin uploads O(held) per pointer move (the held positions
 * written once per tick, at its start, not per move), and the layout reflowing (ticks and repaints) while
 * the node is held.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import { network, type Network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { DEFAULT_FORCE, seedPositions } from "../../force.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { AsyncPositionReadback } from "../async-readback.js";
import { DEFAULT_BUDGET_MS, frameBudgetMs, itemCostMs, stageBands } from "../frame-budget.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { MIN_FRAME_MS } from "../repaint-throttle.js";
import { makeTestDevice } from "./_device.js";
import { InstancedArrows, InstancedCircles, InstancedHalfArrows, InstancedLines, InstancedPie } from "../../../webgl/instanced.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";

const LOCAL_N = 100_000; // the N the ceilings below were calibrated at
// Capped: SwiftShader (CI) ticks at ~3.4 ms per 1k nodes, so even the short run below would exceed the
// tier's per-file budget far past 200k. Real-GPU runs at 325k / 1M go through PERF_BROWSER_N by hand.
const N = perfN(LOCAL_N, { max: 1_000_000 });
const ITERATIONS = 60;
const W = 800;
const H = 600;

/** Minimal seeded LCG. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A clustered graph at ~2.3 edges per node (mostly intra-community), the GPU guards' fixture shape. */
function clustered(n: number, seed: number): NetworkGraph {
  const rng = makePrng(seed);
  const communities = Math.max(1, Math.round(n / 400));
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = Math.floor((i / n) * communities);
    const c0 = Math.floor((c / communities) * n);
    const c1 = Math.floor(((c + 1) / communities) * n);
    source.push(i);
    target.push(c0 + Math.floor(rng() * Math.max(1, c1 - c0)));
    if (rng() < 0.3) {
      source.push(i);
      target.push(Math.floor(rng() * n));
    }
  }
  return buildGraph({ nodeCount: n, source, target });
}

// ── GL call log ─────────────────────────────────────────────────────────────

type GlEvent =
  | { kind: "copy"; toPbo: boolean }
  | { kind: "harvest" }
  | { kind: "fence"; sync: WebGLSync | null }
  | { kind: "wait"; sync: WebGLSync; signaled: boolean }
  | { kind: "layout-draw" }
  | { kind: "create"; inSolver: boolean }
  | { kind: "seed-begin" }
  | { kind: "seed-begun" }
  | { kind: "lane-begin" }
  | { kind: "lane-end"; before: number; after: number }
  | { kind: "frame-end" };

/**
 * Logs the GL calls the streaming contract is about, in order, by wrapping the installed prototype
 * methods (cast-free: `defineProperty` takes the wrapper as a plain value) and restoring them after.
 * Each instanced lane's `update` is bracketed with its capacity before and after, so a GPU object
 * created inside it reads as that lane growing (see {@link attributeCreates}).
 */
class GlCallLog {
  readonly events: GlEvent[] = [];
  private readonly restores: (() => void)[] = [];

  /** `inSolver` says whether a GPU object is created inside a solver work item (see {@link solverScope}). */
  constructor(inSolver: () => boolean = () => false) {
    const proto = WebGL2RenderingContext.prototype;
    const log = this.events;
    this.wrap(proto, "readPixels", (gl, args) => log.push({ kind: "copy", toPbo: typeof args[6] === "number" }));
    this.wrap(proto, "getBufferSubData", (gl, args) => {
      if (args[0] === gl.PIXEL_PACK_BUFFER) log.push({ kind: "harvest" });
    });
    this.wrap(proto, "clientWaitSync", (gl, args, result) => {
      const sync = args[0];
      if (sync instanceof WebGLSync) {
        log.push({ kind: "wait", sync, signaled: result === gl.ALREADY_SIGNALED || result === gl.CONDITION_SATISFIED });
      }
    });
    this.wrap(proto, "fenceSync", (_gl, _args, result) => log.push({ kind: "fence", sync: result instanceof WebGLSync ? result : null }));
    // The layout draws into its own framebuffers with plain drawArrays; the engine's lanes are instanced
    // draws into the canvas.
    this.wrap(proto, "drawArrays", (gl) => {
      if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null) log.push({ kind: "layout-draw" });
    });
    for (const name of ["createBuffer", "createTexture", "createFramebuffer"] as const) {
      this.wrap(proto, name, () => log.push({ kind: "create", inSolver: inSolver() }));
    }
    this.wrapLane(InstancedCircles.prototype);
    this.wrapLane(InstancedPie.prototype);
    this.wrapLane(InstancedLines.prototype);
    this.wrapLane(InstancedArrows.prototype);
    this.wrapLane(InstancedHalfArrows.prototype);
  }

  private wrapLane<A extends unknown[], R>(proto: { readonly capacity: number; update(...args: A): R }): void {
    const installed = proto.update;
    const log = this.events;
    Object.defineProperty(proto, "update", {
      configurable: true,
      writable: true,
      value: function (this: { readonly capacity: number }, ...args: A): R {
        const before = this.capacity;
        log.push({ kind: "lane-begin" });
        const result = installed.apply(this, args);
        log.push({ kind: "lane-end", before, after: this.capacity });
        return result;
      },
    });
    this.restores.push(() => Object.defineProperty(proto, "update", { configurable: true, writable: true, value: installed }));
  }

  private wrap(
    proto: WebGL2RenderingContext,
    name: "readPixels" | "getBufferSubData" | "clientWaitSync" | "fenceSync" | "drawArrays" | "createBuffer" | "createTexture" | "createFramebuffer",
    after: (gl: WebGL2RenderingContext, args: unknown[], result: unknown) => void,
  ): void {
    const installed: unknown = Reflect.get(proto, name);
    if (typeof installed !== "function") throw new Error(`no ${name}`);
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function (this: WebGL2RenderingContext, ...args: unknown[]) {
        const result: unknown = Reflect.apply(installed, this, args);
        after(this, args, result);
        return result;
      },
    });
    this.restores.push(() => Object.defineProperty(proto, name, { configurable: true, writable: true, value: installed }));
  }

  restore(): void {
    for (const r of this.restores) r();
  }
}

/** What one leg observed. */
interface Leg {
  frames: GpuFrameSample[];
  /** Per frame: whether the worker's LOD tree was drawn (#377). */
  treeFrames: boolean[];
  /** Per frame: whether the frame ended with the LOD tree in place (`lodSource` not "none"). */
  cut: boolean[];
  lod: boolean;
  events: GlEvent[];
  settledAfterFrame: number;
  elapsedMs: number;
  /** Main-thread ms of each `GpuForceLayout.beginSeed` (the seed's allocation, when its plan arrives). */
  beginSeedMs: number[];
  /** `device.submit()` calls of each solver work item, and of each readback copy's `issue` (#402). */
  itemSubmits: number[];
  copySubmits: number[];
}

/**
 * Mark the solver's work items — a seed level's placement (`setLevel`), the nodes' (`endSeed`), and a tick's
 * items — so the GL log can tell a GPU object a work item creates in a frame from the engine's own (its first
 * repaint of new data sizes its lanes) and from the solver's construction. `inside()` reads the mark. It also
 * counts the `device.submit()` calls of each item (`itemSubmits`) and of each readback copy's `issue`
 * (`copySubmits`), which runs after the solver's `prepareReadback` (#402: once each).
 */
function solverScope(): { inside: () => boolean; itemSubmits: number[]; copySubmits: number[]; restore: () => void } {
  let depth = 0;
  let submits = 0;
  const itemSubmits: number[] = [];
  const copySubmits: number[] = [];
  const proto = GpuForceLayout.prototype;
  const { setLevel, endSeed, beginTick, forceBand, integrate } = proto;
  const { issue } = AsyncPositionReadback.prototype;
  const { submit } = WebGLDevice.prototype;
  const counted = (into: number[], run: () => void): void => {
    const before = submits;
    try {
      run();
    } finally {
      into.push(submits - before);
    }
  };
  const scoped = (run: () => void): void => {
    depth++;
    try {
      counted(itemSubmits, run);
    } finally {
      depth--;
    }
  };
  const spies = [
    vi.spyOn(proto, "setLevel").mockImplementation(function (this: GpuForceLayout, k: number) { scoped(() => setLevel.call(this, k)); }),
    vi.spyOn(proto, "endSeed").mockImplementation(function (this: GpuForceLayout) { scoped(() => endSeed.call(this)); }),
    vi.spyOn(proto, "beginTick").mockImplementation(function (this: GpuForceLayout) { scoped(() => beginTick.call(this)); }),
    vi.spyOn(proto, "forceBand").mockImplementation(function (this: GpuForceLayout, band: number, bands: number) { scoped(() => forceBand.call(this, band, bands)); }),
    vi.spyOn(proto, "integrate").mockImplementation(function (this: GpuForceLayout) { scoped(() => integrate.call(this)); }),
    vi.spyOn(AsyncPositionReadback.prototype, "issue").mockImplementation(function (this: AsyncPositionReadback, source) {
      counted(copySubmits, () => issue.call(this, source));
    }),
    vi.spyOn(WebGLDevice.prototype, "submit").mockImplementation(function (this: WebGLDevice, ...args: Parameters<WebGLDevice["submit"]>) {
      submits++;
      submit.apply(this, args);
    }),
  ];
  return { inside: () => depth > 0, itemSubmits, copySubmits, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

/**
 * Run one GPU layout on `net` over `graph` at the current view, recording every streamed frame and the GL
 * call log. A leg that follows a drag must set its view first: at the drag's k = 4 zoom the cut's layer set
 * changes as links enter the view, and each change re-registers the lane's layers.
 */
async function streamLeg(net: Network, graph: NetworkGraph, lod: boolean, multilevel = true): Promise<Leg> {
  const frames: GpuFrameSample[] = [];
  const treeFrames: boolean[] = [];
  const cut: boolean[] = [];
  const scope = solverScope();
  const log = new GlCallLog(scope.inside);
  let settledAfterFrame = -1;
  const unobserve = observeGpuLayoutFrames((s) => {
    frames.push({ ...s });
    treeFrames.push(net.lodSource === "worker");
    cut.push(net.lodSource !== "none");
    log.events.push({ kind: "frame-end" });
  });
  // The seed's allocation, marked in the GL log and timed: it runs when the plan arrives, outside any frame.
  const beginSeedMs: number[] = [];
  const beginSeed = GpuForceLayout.prototype.beginSeed;
  const seedSpy = vi.spyOn(GpuForceLayout.prototype, "beginSeed").mockImplementation(function (this: GpuForceLayout, plan) {
    log.events.push({ kind: "seed-begin" });
    const b0 = performance.now();
    try {
      beginSeed.call(this, plan);
    } finally {
      beginSeedMs.push(performance.now() - b0);
      log.events.push({ kind: "seed-begun" });
    }
  });
  const t0 = performance.now();
  try {
    net.data(graph).lod(lod ? { source: "structure", declutter: true, superEdges: true } : false);
    net.layout({ backend: "gpu", iterations: ITERATIONS, multilevel });
    await net.whenSettled();
    settledAfterFrame = frames.length;
  } finally {
    unobserve();
    log.restore();
    seedSpy.mockRestore();
    scope.restore();
  }
  expect(net.layoutTransport).toBe("gpu");
  return {
    frames, treeFrames, cut, lod, events: log.events, settledAfterFrame, elapsedMs: performance.now() - t0, beginSeedMs,
    itemSubmits: scope.itemSubmits, copySubmits: scope.copySubmits,
  };
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Frames a drag holds its node (one pointer move each), and frames observed after the release. */
const DRAG_FRAMES = 24;
const COOL_FRAMES = 24;
/**
 * After its moves, a drag keeps holding its node, still, until the layout has repainted once, for at most
 * this long. The repaint throttle keeps the stall samples of the run before the drag, so on software GL
 * (SwiftShader: seconds of GPU stall per fit-view frame at 100k, measured 4.5-9.3 s intervals) the first
 * reflow repaint can land after the DRAG_FRAMES moves. On a GPU the stall term is about 0.
 */
const HOLD_UNTIL_REPAINT_MS = 20_000;
/** Zoom of the drag: leaves are drawn at their own size under either reduction state (spacing ≈ 56 world units). */
const DRAG_K = 4;
/** Nodes {@link centreOnDrawnLeaf} tries before it gives up. */
const GRAB_TRIES = 64;

/**
 * Centre the view at the drag zoom on the first node, from `from` on, that is drawn as a leaf under the
 * view centre, and return its id. Which nodes are drawn there depends on the layout, and the GPU layout
 * differs by platform: SwiftShader compiles its shaders with LLVM on arm64 and with Subzero on x86-64 (the
 * CI runners), so the same run lands the nodes elsewhere. Under LOD the declutter hides a few leaves
 * outright (about 3% at this N), with no drawn glyph over their centre, so a fixed id can leave the
 * pointer-down nothing to grab. The search asks the same `pick` the pointer-down grab resolves through.
 */
function centreOnDrawnLeaf(net: Network, graph: NetworkGraph, from: number): number {
  for (let id = from; id < Math.min(graph.nodeCount, from + GRAB_TRIES); id++) {
    const x0 = graph.positions[id * 2] ?? 0;
    const y0 = graph.positions[id * 2 + 1] ?? 0;
    net.setTransform({ k: DRAG_K, x: W / 2 - x0 * DRAG_K, y: H / 2 - y0 * DRAG_K });
    const hit = net.pick(W / 2, H / 2);
    if (hit?.layer === "nodes" && hit.id === id) return id;
  }
  throw new Error(`no node in ${from}…${from + GRAB_TRIES - 1} is drawn as a leaf under the view centre at k=${DRAG_K}`);
}

/** What one drag leg observed. */
interface DragLeg {
  held: GpuFrameSample[];
  cool: GpuFrameSample[];
  events: GlEvent[];
  /** Nodes the drag held, and every id count the solver's pin calls saw. */
  heldCount: number;
  pinnedSizes: number[];
  heldWriteSizes: number[];
  /** Ticks begun during the leg (each may write the held positions once, at its start). */
  ticksBegun: number;
  /** Main-thread ms of each pointer move's handler (the engine's held-set repaint plus the pin). */
  moveMs: number[];
}

/**
 * Grab a drawn leaf of the settled layout on `net` (the first from node `from` on), drag it for DRAG_FRAMES
 * frames, hold it still until the layout has repainted (at most HOLD_UNTIL_REPAINT_MS), release, watch
 * COOL_FRAMES frames.
 */
async function dragLeg(net: Network, host: HTMLElement, graph: NetworkGraph, from: number): Promise<DragLeg> {
  centreOnDrawnLeaf(net, graph, from);
  await nextFrame();
  const rect = host.getBoundingClientRect();
  const pointer = (type: string, x: number, y: number): void => {
    host.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, button: 0, pointerId: 1 }));
  };
  const frames: GpuFrameSample[] = [];
  const log = new GlCallLog();
  const pinned = vi.spyOn(GpuForceLayout.prototype, "setPinned");
  const heldWrites = vi.spyOn(GpuForceLayout.prototype, "setHeldPositions");
  const begun = vi.spyOn(GpuForceLayout.prototype, "beginTick");
  const unobserve = observeGpuLayoutFrames((s) => {
    frames.push({ ...s });
    log.events.push({ kind: "frame-end" });
  });
  const moveMs: number[] = [];
  let released = 0;
  try {
    pointer("pointerdown", W / 2, H / 2);
    pointer("pointermove", W / 2 + 8, H / 2); // past the click slop: the drag session starts
    for (let f = 1; f <= DRAG_FRAMES; f++) {
      const t0 = performance.now();
      pointer("pointermove", W / 2 + 8 + 4 * f, H / 2 - 2 * f);
      moveMs.push(performance.now() - t0);
      await nextFrame();
    }
    const holdUntil = performance.now() + HOLD_UNTIL_REPAINT_MS;
    while (!frames.some((s) => s.repainted) && performance.now() < holdUntil) await nextFrame();
    released = frames.length;
    pointer("pointerup", W / 2 + 8 + 4 * DRAG_FRAMES, H / 2 - 2 * DRAG_FRAMES);
    for (let f = 0; f < COOL_FRAMES; f++) await nextFrame();
  } finally {
    unobserve();
    log.restore();
  }
  const pinnedSizes = pinned.mock.calls.map((c) => c[0]?.length ?? 0);
  const heldWriteSizes = heldWrites.mock.calls.map((c) => c[0].length);
  const ticksBegun = begun.mock.calls.length;
  pinned.mockRestore();
  heldWrites.mockRestore();
  begun.mockRestore();
  return {
    held: frames.slice(0, released),
    cool: frames.slice(released),
    events: log.events,
    heldCount: pinnedSizes[0] ?? 0,
    pinnedSizes,
    heldWriteSizes,
    ticksBegun,
    moveMs,
  };
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}
function quantile(xs: number[], q: number): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

/** Split the log into per-frame segments (the observer closes each frame). */
function perFrame(events: GlEvent[]): GlEvent[][] {
  const out: GlEvent[][] = [[]];
  for (const e of events) {
    if (e.kind === "frame-end") out.push([]);
    else out[out.length - 1]?.push(e);
  }
  out.pop(); // after the last frame-end: the settle repaint etc., not a streamed frame
  return out;
}

/**
 * Split the GPU objects created in `events` into the grows of an instanced lane (created inside its
 * `update` while its capacity rose) and the rest (`stray`): anything the transport or the engine created
 * outside a lane update, and a lane update that recreated its buffers without growing them.
 */
function attributeCreates(events: GlEvent[]): { stray: number; grows: { before: number; after: number }[] } {
  let stray = 0;
  let open = false;
  let inLane = 0;
  const grows: { before: number; after: number }[] = [];
  for (const e of events) {
    if (e.kind === "lane-begin") {
      open = true;
      inLane = 0;
    } else if (e.kind === "create") {
      if (open) inLane++;
      else stray++;
    } else if (e.kind === "lane-end") {
      open = false;
      if (inLane > 0 && e.after > e.before) grows.push({ before: e.before, after: e.after });
      else stray += inLane;
    }
  }
  return { stray, grows };
}

/** The deterministic streaming signatures every leg must show. */
function assertSignatures(leg: Leg): void {
  const { frames, events } = leg;
  expect(frames.length).toBeGreaterThan(3);

  // Every readPixels on the streaming path lands in a PBO.
  const copies = events.filter((e) => e.kind === "copy");
  expect(copies.length).toBeGreaterThan(0);
  expect(copies.every((e) => e.kind === "copy" && e.toPbo), "a synchronous readPixels on the streaming path").toBe(true);

  // Every harvest reads a copy whose fence (inserted after the copy) was seen signalled before it.
  const fenceAt = new Map<WebGLSync, number>();
  let lastCopy = -1;
  events.forEach((e, i) => {
    if (e.kind === "copy") lastCopy = i;
    else if (e.kind === "fence" && e.sync) fenceAt.set(e.sync, i);
    else if (e.kind === "harvest") {
      let ok = false;
      for (let j = i - 1; j > lastCopy && !ok; j--) {
        const w = events[j];
        if (w?.kind === "wait" && w.signaled && (fenceAt.get(w.sync) ?? -1) > lastCopy) ok = true;
      }
      expect(ok, `harvest #${i} before its copy's fence signalled`).toBe(true);
    }
  });

  // One submit per solver work item (a seed step or a tick's P, F_b or I) and per readback copy (#402):
  // luma's submit allocates a command encoder, a command buffer and a promise, and none of it is needed
  // between the passes of an item.
  expect(leg.itemSubmits.length).toBeGreaterThanOrEqual(3 * ticksRun(frames)); // a tick is P, F_0 … F_{B−1}, I
  expect(leg.itemSubmits.filter((n) => n !== 1), "work items that did not submit exactly once").toEqual([]);
  expect(leg.copySubmits.length).toBeGreaterThan(0);
  expect(leg.copySubmits.filter((n) => n !== 1), "readback copies that did not submit exactly once").toEqual([]);

  const segments = perFrame(events);
  expect(segments.length).toBe(frames.length);
  segments.forEach((seg, f) => {
    // One budget fence per frame.
    expect(seg.filter((e) => e.kind === "fence").length, `frame ${f} fences`).toBe(1);
    // The harvest precedes every layout draw of the frame.
    const harvest = seg.findIndex((e) => e.kind === "harvest");
    if (harvest >= 0) {
      const firstDraw = seg.findIndex((e) => e.kind === "layout-draw");
      if (firstDraw >= 0) expect(harvest, `frame ${f}: harvest after an encode`).toBeLessThan(firstDraw);
    }
  });

  // No GPU object created per frame once the stream runs (the first repaint of new data may allocate
  // the lanes' buffers; everything after it reuses them). Under LOD that repaint is the first to draw
  // the cut: the main thread builds the tree on a GPU frame, and until it has geometry the cut draws
  // nothing, so the lanes register with the tree, frames after the stream's first repaint. One
  // exception, bounded: the visible frontier grows while the layout spreads (a few hundred glyphs
  // growing about fourfold at this N), and a lane that outgrows its buffers reallocates them. Each grow
  // must at least double the lane's capacity, so it happens log2(peak / first) times over the run; an
  // exact fit reallocated on every repaint that set a new high.
  const firstRepaint = frames.findIndex((s, f) => s.repainted && (!leg.lod || leg.cut[f] === true));
  const { stray, grows } = attributeCreates(segments.slice(firstRepaint + 1).flat());
  expect(stray, "GPU objects created per streamed frame").toBe(0);
  for (const g of grows) {
    expect(g.after, `an instanced lane grew from ${g.before} to ${g.after} instances, less than double`).toBeGreaterThanOrEqual(2 * g.before);
  }

  // Repaints throttled to ≥ minFrameMs apart (the final one, which always paints, excepted). Counted by the
  // `repainted` flag, as the drag legs are: a clamped clock measures a cheap repaint as 0 ms.
  const repaints = frames.filter((s) => s.repainted).map((s) => s.now);
  for (let i = 1; i < repaints.length - 1; i++) {
    expect((repaints[i] ?? 0) - (repaints[i - 1] ?? 0)).toBeGreaterThanOrEqual(MIN_FRAME_MS - 2);
  }

  // The real transport admits a frame's items through the budget (#382): past the first item, one only while
  // the estimates' sum fits. A guard on the wiring (schedule → budget → sample), not on the estimates.
  frames.forEach((s, f) => {
    if (s.items > 1) expect(s.itemsMs, `frame ${f}: ${s.items} items`).toBeLessThanOrEqual(s.budgetMs + 1e-9);
  });

  // settled only after the final positions were harvested: the budget's last tick, or the tick the
  // convergence stop latched at (#376) — a seeded layout (#353) converges within the budget.
  const finalTick = ticksRun(frames);
  expect(finalTick).toBeLessThanOrEqual(ITERATIONS);
  const finalHarvest = frames.findIndex((s) => s.harvestedTicks >= finalTick);
  expect(finalHarvest).toBeGreaterThanOrEqual(0);
  expect(finalHarvest).toBeLessThan(leg.settledAfterFrame);
}

/**
 * GPU-only ticks/s over `ticks` ticks each cut into `bands` row bands (P, F_0 … F_{bands−1}, I), fenced by a
 * synchronous read, and the main-thread encode ms per tick. One warm-up tick first.
 */
function slicedRate(solo: GpuForceLayout, out: Float32Array, bands: number, ticks: number): { ticksPerSec: number; encodeMsPerTick: number } {
  const tick = (): void => {
    solo.beginTick();
    for (let b = 0; b < bands; b++) solo.forceBand(b, bands);
    solo.integrate();
  };
  tick();
  solo.readPositions(out);
  let encode = 0;
  const t0 = performance.now();
  for (let t = 0; t < ticks; t++) {
    const e0 = performance.now();
    tick();
    encode += performance.now() - e0;
  }
  solo.readPositions(out);
  return { ticksPerSec: (ticks * 1000) / (performance.now() - t0), encodeMsPerTick: encode / ticks };
}

/**
 * The GPU-only tick rate on this machine: a separate solver from the seed the layout starts from, run and
 * fenced, before any stream. Also reported with the tick cut into the static band counts the stream starts
 * from at 60 Hz and 120 Hz (report only; 5 ticks keep the SwiftShader tier's cost small).
 */
async function gpuOnlyRate(graph: NetworkGraph): Promise<{ ticksPerSec: number; report: string }> {
  const device: Device = await makeTestDevice();
  try {
    const seeded = { ...graph, positions: graph.positions.slice() };
    seedPositions(seeded, W, H, { force: DEFAULT_FORCE });
    const solo = new GpuForceLayout(device, seeded, DEFAULT_FORCE);
    const out = new Float32Array(N * 2);
    solo.runFrame(2);
    solo.readPositions(out);
    const t0 = performance.now();
    solo.runFrame(10);
    const encodeMs = performance.now() - t0;
    solo.readPositions(out);
    const ticksPerSec = 10_000 / (performance.now() - t0);
    let report = `B=1 ${ticksPerSec.toFixed(1)} ticks/s (encode ${(encodeMs / 10).toFixed(2)} ms/tick)`;
    const sliced = new Set([60, 120].map((hz) => stageBands(itemCostMs("force", N), frameBudgetMs(DEFAULT_BUDGET_MS, 1000 / hz), solo.atlasRows)));
    for (const bands of sliced) {
      if (bands === 1) continue;
      const rate = slicedRate(solo, out, bands, 5);
      report += `; B=${bands} ${rate.ticksPerSec.toFixed(1)} ticks/s (encode ${rate.encodeMsPerTick.toFixed(2)} ms/tick)`;
    }
    solo.destroy();
    return { ticksPerSec, report };
  } finally {
    device.destroy();
  }
}

/** The ticks a streamed run refined: its budget, or fewer when the convergence stop latched first (#376). */
function ticksRun(frames: readonly GpuFrameSample[]): number {
  const stopTick = frames[frames.length - 1]?.stopTick ?? -1;
  return stopTick >= 0 ? stopTick : ITERATIONS;
}

function report(label: string, leg: Leg): { transport: number[]; encode: number[]; ticksPerSec: number } {
  const { frames } = leg;
  const transport = frames.map((s) => s.harvestMs + s.encodeMs);
  const encode = frames.map((s) => s.encodeMs);
  const repaint = frames.filter((s) => s.repainted).map((s) => s.repaintMs);
  const intervals = frames.slice(1).map((s, i) => s.now - (frames[i]?.now ?? s.now));
  const first = frames[0]?.now ?? 0;
  const last = frames[frames.length - 1]?.now ?? first;
  const ticks = ticksRun(frames);
  const ticksPerSec = (ticks / Math.max(1, last - first)) * 1000;
  console.log(
    `  GPU stream [${label}] N=${N}: ${frames.length} frames, ${repaint.length} repaints, ` +
      `transport ms/frame median ${median(transport).toFixed(2)} p95 ${quantile(transport, 0.95).toFixed(2)} max ${Math.max(...transport).toFixed(2)}; ` +
      `encode median ${median(encode).toFixed(2)} p95 ${quantile(encode, 0.95).toFixed(2)}; ` +
      `repaint ms median ${median(repaint).toFixed(1)} max ${Math.max(0, ...repaint).toFixed(1)}; ` +
      `rAF interval median ${median(intervals).toFixed(1)} ms; ${ticksPerSec.toFixed(1)} ticks/s; ` +
      `${ticks} ticks in ${leg.elapsedMs.toFixed(0)} ms; bands ${frames[frames.length - 1]?.bands}, blocked ${frames.filter((s) => s.blocked).length}`,
  );
  return { transport, encode, ticksPerSec };
}

/**
 * Ceilings of the seed (#353). `beginSeed` creates the seed's textures and uploads nothing but a root texel and
 * the hub table: measured 7.4-9.0 ms on an M1 Max and under SwiftShader alike, the same for a 2,000-node graph
 * as at 325k (a constant, so the ceiling is not split by N). Its programs are the solver's, compiled at
 * construction (a hub-row spring program compiled here instead cost 122 ms on an M1 Max). A seed frame encodes placements (a level's sub-uploads plus one gather) and seed ticks
 * under the 2 ms encode cap; the largest level's upload is the costliest item.
 */
const BEGIN_SEED_MS = perfBudget(15);
const SEED_FRAME_MAX_MS = perfBudget(20);

/**
 * The multilevel seed's signatures (#353): it ran once — the first frame harvested is the seed frame, tick 0;
 * no seed work item created a GPU object (the seed's textures come from `beginSeed`, when the plan arrives,
 * outside the frame loop); `beginSeed` compiled nothing (its ceiling); and no seed frame's transport exceeded
 * its ceiling.
 */
function assertSeed(label: string, leg: Leg): { seedFrames: number; seedMs: number } {
  const { frames, events } = leg;
  const firstHarvest = frames.findIndex((s) => s.harvested);
  expect(firstHarvest, "nothing was harvested").toBeGreaterThanOrEqual(0);
  expect(frames[firstHarvest]?.harvestedTicks, "the first frame harvested is not the seed frame").toBe(0);
  expect(leg.beginSeedMs.length, "the seed did not start exactly once").toBe(1);
  // The seed's frames: every one before the first harvest. Their work items create nothing; `beginSeed`
  // (between its markers) creates the seed's textures, once.
  let inBeginSeed = false;
  let creates = 0;
  let seedCreates = 0;
  for (const seg of perFrame(events).slice(0, firstHarvest)) {
    for (const e of seg) {
      if (e.kind === "seed-begin") inBeginSeed = true;
      else if (e.kind === "seed-begun") inBeginSeed = false;
      else if (e.kind === "create" && inBeginSeed) seedCreates++;
      else if (e.kind === "create" && e.inSolver) creates++;
    }
  }
  expect(creates, "GPU objects created by a seed work item").toBe(0);
  expect(seedCreates, "beginSeed created no texture (a vacuous marker?)").toBeGreaterThan(0);
  const seedTransport = frames.slice(0, firstHarvest).map((s) => s.harvestMs + s.encodeMs);
  const seedEncode = frames.slice(0, firstHarvest).map((s) => s.encodeMs);
  const seedMs = (frames[firstHarvest]?.now ?? 0) - (frames[0]?.now ?? 0);
  const beginMs = leg.beginSeedMs[0] ?? 0;
  console.log(
    `  GPU seed [${label}] N=${N}: ${firstHarvest} frames (${seedMs.toFixed(0)} ms) to the seed frame; beginSeed ${beginMs.toFixed(2)} ms; ` +
      `seed frames' transport median ${median(seedTransport).toFixed(2)} max ${Math.max(0, ...seedTransport).toFixed(2)} ms, ` +
      `encode median ${median(seedEncode).toFixed(2)} max ${Math.max(0, ...seedEncode).toFixed(2)} ms`,
  );
  expect(beginMs, "beginSeed over its ceiling (a compile or an upload moved into it?)").toBeLessThan(BEGIN_SEED_MS);
  expect(Math.max(0, ...seedTransport), "a seed frame over the max transport ceiling").toBeLessThan(SEED_FRAME_MAX_MS);
  return { seedFrames: firstHarvest, seedMs };
}

/** The drag leg's signatures: the transport's per-frame contract holds through the drag, and the pins are O(held). */
function assertDrag(label: string, leg: DragLeg, transportP95Ms: number, encodeMedianMs: number): void {
  const frames = [...leg.held, ...leg.cool];
  const transport = frames.map((s) => s.harvestMs + s.encodeMs);
  const encode = frames.map((s) => s.encodeMs);
  const repaints = frames.filter((s) => s.repainted);
  const heldTicks = (leg.held[leg.held.length - 1]?.ticksDone ?? 0) - (leg.held[0]?.ticksDone ?? 0);
  const heldSpan = ((leg.held[leg.held.length - 1]?.now ?? 0) - (leg.held[0]?.now ?? 0)) / 1000;
  console.log(
    `  GPU drag [${label}] N=${N}: held ${leg.heldCount} node(s); ${leg.held.length} held + ${leg.cool.length} re-cool frames, ` +
      `${repaints.length} repaints (ms median ${median(repaints.map((s) => s.repaintMs)).toFixed(1)}); ` +
      `transport ms/frame median ${median(transport).toFixed(2)} p95 ${quantile(transport, 0.95).toFixed(2)} max ${Math.max(...transport).toFixed(2)}; ` +
      `pointer-move handler ms median ${median(leg.moveMs).toFixed(2)} max ${Math.max(...leg.moveMs).toFixed(2)}; ` +
      `${heldTicks} ticks while held (${(heldTicks / Math.max(1e-3, heldSpan)).toFixed(1)} ticks/s); ` +
      `setPinned ${leg.pinnedSizes.length}×, held-position writes ${leg.heldWriteSizes.length}× over ${leg.ticksBegun} ticks begun`,
  );

  expect(leg.heldCount, "the drag grabbed nothing").toBeGreaterThan(0);
  expect(leg.held.length).toBeGreaterThan(DRAG_FRAMES / 2);
  // The layout reflows while the node is held: ticks run and positions reach the screen.
  expect(heldTicks, "no reheat ticks while held").toBeGreaterThan(0);
  expect(repaints.length, "no layout repaint during the drag").toBeGreaterThan(0);

  // The transport's per-frame bounds hold through the drag and the re-cool, and so does the budget's admission (#382).
  expect(quantile(transport, 0.95)).toBeLessThan(transportP95Ms);
  expect(median(encode)).toBeLessThan(encodeMedianMs);
  frames.forEach((s, f) => {
    if (s.items > 1) expect(s.itemsMs, `drag frame ${f}: ${s.items} items`).toBeLessThanOrEqual(s.budgetMs + 1e-9);
  });

  // GL signatures: every copy into a PBO, one fence per frame, the harvest before the frame's layout draws,
  // and no GPU object created by any drag frame or pointer move.
  const copies = leg.events.filter((e) => e.kind === "copy");
  expect(copies.every((e) => e.kind === "copy" && e.toPbo), "a synchronous readPixels during the drag").toBe(true);
  const segments = perFrame(leg.events);
  expect(segments.length).toBe(frames.length);
  segments.forEach((seg, f) => {
    expect(seg.filter((e) => e.kind === "fence").length, `drag frame ${f} fences`).toBe(1);
    const harvest = seg.findIndex((e) => e.kind === "harvest");
    const firstDraw = seg.findIndex((e) => e.kind === "layout-draw");
    if (harvest >= 0 && firstDraw >= 0) expect(harvest, `drag frame ${f}: harvest after an encode`).toBeLessThan(firstDraw);
  });
  expect(leg.events.filter((e) => e.kind === "create").length, "GPU objects created during the drag").toBe(0);

  // Pins are O(held) per pointer move: one setPinned per move (plus the release's), each over the held
  // set; the held positions are written at most once per tick (at its start), each over the held set.
  expect(leg.pinnedSizes.length).toBeLessThanOrEqual(DRAG_FRAMES + 3);
  expect(leg.pinnedSizes.every((n) => n === leg.heldCount || n === 0)).toBe(true);
  expect(leg.heldWriteSizes.length).toBeGreaterThan(0);
  expect(leg.heldWriteSizes.length).toBeLessThanOrEqual(leg.ticksBegun);
  expect(leg.heldWriteSizes.every((n) => n === leg.heldCount)).toBe(true);
}

/** Ticks of the worker-backend baseline leg: a CPU tick at this N takes ~0.1-0.3 s and posts one frame. */
const WORKER_ITERATIONS = 12;

/**
 * The fit-like view both LOD-on legs are measured at: the whole force-equilibrium disc (radius
 * √(repulsion·N / centering), where both layouts are seeded) in view — the Navigator's `fit: true` framing,
 * and the largest LOD frontier a layout frame paints.
 */
function fitView(): { k: number; x: number; y: number } {
  const radius = Math.sqrt((DEFAULT_FORCE.repulsion * N) / DEFAULT_FORCE.centering);
  return { k: (0.85 * Math.min(W, H)) / (2 * radius), x: W / 2, y: H / 2 };
}

/** Main-thread ms of every animation-frame callback while installed — the worker backend's layout repaints. */
function timeAnimationFrames(): { durations: number[]; restore: () => void } {
  const installed = window.requestAnimationFrame;
  const durations: number[] = [];
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    installed.call(window, (t: number) => {
      const t0 = performance.now();
      try {
        callback(t);
      } finally {
        durations.push(performance.now() - t0);
      }
    });
  return { durations, restore: () => { window.requestAnimationFrame = installed; } };
}

/**
 * Which part of T7 a file runs. T7 runs as three files, one per reduction state and one for the seeded LOD
 * run (the Navigator's config, #353), because the browser tier gives each file its own process and a 300 s
 * budget (scripts/run-browser-perf-tier.mjs). On the CI runners the legs together take 250-300 s and more:
 * under SwiftShader every 100k-node full-detail repaint holds the next animation frame for seconds, a drag
 * repaints tens of times, and each of the four streams runs 60 ticks. Each part builds its own engine and
 * fixture; only the LOD-off part measures the GPU-only tick rate its throughput floor needs.
 */
export type StreamPart = "LOD off" | "LOD on" | "LOD on, seeded";

/** Register T7's legs for one part (see {@link StreamPart}). */
export function describeGpuStream(part: StreamPart): void {
  const off = part === "LOD off";
  describe(`GPU layout streaming per frame (#352), ${part} — network().layout({ backend: 'gpu' })`, () => {
    let host: HTMLElement;
    let net: Network;
    let graph: NetworkGraph;
    let gpuOnlyTicksPerSec = 0;
    let gpuOnlyReport = "";
    /** The LOD-on leg's main-thread ms per repaint with the worker's tree drawn (commit + repaint), for the baseline leg. */
    let gpuLodRepaintMs: number[] = [];

    beforeAll(async () => {
      graph = clustered(N, 0x5712);
      if (off) ({ ticksPerSec: gpuOnlyTicksPerSec, report: gpuOnlyReport } = await gpuOnlyRate(graph));
      host = perfHost(W, H);
      net = network(host, { width: W, height: H, backend: "webgl" });
      await net.whenReady();
      net.interactive({ draggable: true });
      // Warm-up on the same engine: the capability probe, shader compiles and the lane programs.
      net.data(clustered(2_000, 1)).layout({ backend: "gpu", iterations: 5 });
      await net.whenSettled();
    }, perfBudget(120_000));

    afterAll(() => {
      net?.destroy();
      host?.remove();
    });

    // Each part's first stream leg runs on its own engine at its initial view (k = 1), before any drag.

    // Calibrated at LOCAL_N (see the PR's Performance section for the measured numbers). The transport's
    // own main-thread work per frame is a fence poll, a memcpy of 8 B per node on harvest frames, and at
    // most 2 ms of encode: constant plus a small linear term. A synchronous read in the frame waits for
    // every queued tick (tens of ms at this N on a real GPU, seconds under SwiftShader).
    const TRANSPORT_P95_MS = perfBudget(4 + 2 * (N / LOCAL_N));
    const ENCODE_MEDIAN_MS = perfBudget(2.5);

    it.runIf(off)("LOD off: bounded transport main thread, async readback signatures, throughput", async () => {
      const leg = await streamLeg(net, graph, false);
      const { transport, encode, ticksPerSec } = report("LOD off", leg);
      console.log(`  GPU-only tick rate: ${gpuOnlyReport}`);
      assertSignatures(leg);
      assertSeed("LOD off", leg);
      expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
      expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
      // The layout gets ≤ 60% of each frame's GPU time, and the encode cap binds at small N: a quarter of
      // the GPU-only rate is a floor a working stream clears with room to spare.
      expect(ticksPerSec).toBeGreaterThan(0.25 * gpuOnlyTicksPerSec * 0.6);
    }, perfBudget(240_000));

    it.runIf(off)("LOD off: a node drag reheats through the same budgeted loop — transport bounds, O(held) pins", async () => {
      const leg = await dragLeg(net, host, graph, 0);
      assertDrag("LOD off", leg, TRANSPORT_P95_MS, ENCODE_MEDIAN_MS);
    }, perfBudget(240_000));

    it.runIf(part === "LOD on")("LOD on (structural cut, declutter, super-edges): the same transport bounds; the tree from the LOD worker", async () => {
      net.setTransform(fitView());
      // From a disc, as the worker baseline below (a seed would make this leg's frontier the seed's).
      const leg = await streamLeg(net, graph, true, false);
      const { transport, encode } = report("LOD on", leg);
      assertSignatures(leg);
      expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
      expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
      // The worker's tree is drawn (#377): the frames painted with it went through the LOD worker, and
      // settled with it.
      expect(net.lodSource).toBe("worker");
      const withTree = leg.frames.filter((s, i) => s.repainted && leg.treeFrames[i] === true);
      expect(withTree.length, "no repaint drew the LOD worker's tree").toBeGreaterThan(3);
      gpuLodRepaintMs = withTree.map((s) => s.commitMs + s.repaintMs);
      const commit = withTree.map((s) => s.commitMs);
      console.log(
        `  GPU stream [LOD on] N=${N}: ${withTree.length} repaints with the worker's tree; main thread per repaint ` +
          `(commit + repaint) median ${median(gpuLodRepaintMs).toFixed(2)} p95 ${quantile(gpuLodRepaintMs, 0.95).toFixed(2)} ms, ` +
          `of which commit (positions + geometry) median ${median(commit).toFixed(2)} max ${Math.max(...commit).toFixed(2)} ms`,
      );
    }, perfBudget(240_000));

    it.runIf(part === "LOD on")("LOD on: a node drag reheats through the same budgeted loop — transport bounds, O(held) pins", async () => {
      const leg = await dragLeg(net, host, graph, Math.floor(N / 2));
      assertDrag("LOD on", leg, TRANSPORT_P95_MS, ENCODE_MEDIAN_MS);
    }, perfBudget(240_000));

    // Lifecycle §5 baseline: the worker backend on the same engine, graph and view, and from the same kind of
    // start — a disc cold start (`multilevel: false`), as the LOD-on GPU leg's. (A multilevel seed is built from
    // the same coarsening hierarchy as the LOD tree, so its aggregates are compact and its frontier a fraction
    // of a disc start's; a seeded side against a cold one would measure the seed, not the transport, and two
    // seeded sides 60 GPU ticks against 12 CPU ticks apart differ in frontier by more than the margin: 1.59
    // under SwiftShader, #353.) The worker's frames arrive one per CPU tick, each coalesced into one
    // animation-frame repaint; timed here are those repaints alone (its message handler's positions + geometry
    // copies are left out, so the baseline is if anything low), while the GPU side counts its commit (the same
    // copies) plus the repaint. The layouts still differ (60 GPU ticks against a few CPU ticks), so the margin
    // is generous; the regression it bounds — a main-thread geometry pass per repaint, O(tree) — is also pinned
    // by exact call counts in `gpu-lod-mainthread.browser.test.ts`.
    const BASELINE_RATIO = 1.5;
    const BASELINE_SLACK_MS = perfBudget(2);

    it.runIf(part === "LOD on")("LOD on: main-thread ms per layout repaint within the worker backend's (lifecycle §5 baseline)", async () => {
      expect(gpuLodRepaintMs.length, "the LOD-on GPU leg must run first").toBeGreaterThan(0);
      net.data(graph).lod({ source: "structure", declutter: true, superEdges: true });
      net.setTransform(fitView());
      const frames = timeAnimationFrames();
      try {
        net.layout({ backend: "worker", iterations: WORKER_ITERATIONS, multilevel: false });
        await net.whenSettled();
      } finally {
        frames.restore();
      }
      expect(net.lodSource).toBe("worker");
      const worker = frames.durations;
      // Under SwiftShader a fit-view repaint holds the next animation frame for seconds, so the worker's frames
      // coalesce into as few as one repaint; on a real GPU each tick gets its own.
      expect(worker.length, "the worker streamed no frame").toBeGreaterThanOrEqual(1);
      const gpu = median(gpuLodRepaintMs);
      const base = median(worker);
      console.log(
        `  LOD repaint baseline N=${N}: GPU (commit + repaint) median ${gpu.toFixed(2)} ms over ${gpuLodRepaintMs.length} repaints; ` +
          `worker backend repaint median ${base.toFixed(2)} ms (p95 ${quantile(worker, 0.95).toFixed(2)}) over ${worker.length} frames; ` +
          `ratio ${(gpu / Math.max(1e-3, base)).toFixed(2)}`,
      );
      expect(gpu).toBeLessThan(BASELINE_RATIO * base + BASELINE_SLACK_MS);
    }, perfBudget(240_000));

    // The Navigator's real path (#353): LOD on with the default seed. The LOD relay's worker builds the plan and
    // the tree from one coarsening, the tree is adopted while the seed runs, and the seed frame goes through the
    // relay's refit before it is painted. Its own leg, without the baseline ratio: a seeded layout's frontier is
    // not a disc start's, so the worker comparison above stays on disc starts.
    it.runIf(part === "LOD on, seeded")("LOD on, seeded (the Navigator's config): the seed through the LOD relay keeps every transport bound", async () => {
      net.setTransform(fitView());
      const leg = await streamLeg(net, graph, true);
      const { transport, encode } = report("LOD on, seeded", leg);
      assertSignatures(leg);
      assertSeed("LOD on", leg);
      expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
      expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
      expect(net.lodSource).toBe("worker");
      expect(leg.frames.some((s, i) => s.repainted && leg.treeFrames[i] === true), "no repaint drew the LOD worker's tree").toBe(true);
    }, perfBudget(240_000));
  });
}
