/**
 * T7 — the streaming GPU layout's per-frame guard (#352, spec §13), run as two files, one per reduction state
 * (`gpu-stream-nolod-perf.browser.test.ts`, `gpu-stream-lod-perf.browser.test.ts`; see {@link StreamHalf}),
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
 * The LOD-on leg reports the main-thread ms per layout repaint (on this path the main thread still
 * builds and refits the LOD tree — PR 3c moves the refit to the worker and compares against the worker
 * baseline); both legs assert the same transport signatures.
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
import { network, type Network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { DEFAULT_FORCE, seedPositions } from "../../force.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { DEFAULT_BUDGET_MS, frameBudgetMs, staticBands } from "../frame-budget.js";
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
  | { kind: "create" }
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

  constructor() {
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
      this.wrap(proto, name, () => log.push({ kind: "create" }));
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
  /** Per frame: whether the frame ended with the LOD tree in place (`lodSource` not "none"). */
  cut: boolean[];
  lod: boolean;
  events: GlEvent[];
  settledAfterFrame: number;
  elapsedMs: number;
}

/**
 * Run one GPU layout on `net` over `graph` at the whole-graph view (both legs alike, whatever view a
 * drag leg left behind), recording every streamed frame and the GL call log.
 */
async function streamLeg(net: Network, graph: NetworkGraph, lod: boolean): Promise<Leg> {
  const frames: GpuFrameSample[] = [];
  const cut: boolean[] = [];
  const log = new GlCallLog();
  let settledAfterFrame = -1;
  const unobserve = observeGpuLayoutFrames((s) => {
    frames.push({ ...s });
    cut.push(net.lodSource !== "none");
    log.events.push({ kind: "frame-end" });
  });
  const t0 = performance.now();
  try {
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.data(graph).lod(lod ? { source: "structure", declutter: true, superEdges: true } : false);
    net.layout({ backend: "gpu", iterations: ITERATIONS });
    await net.whenSettled();
    settledAfterFrame = frames.length;
  } finally {
    unobserve();
    log.restore();
  }
  expect(net.layoutTransport).toBe("gpu");
  return { frames, cut, lod, events: log.events, settledAfterFrame, elapsedMs: performance.now() - t0 };
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Frames a drag holds its node (one pointer move each), and frames observed after the release. */
const DRAG_FRAMES = 24;
const COOL_FRAMES = 24;
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
 * frames, release, watch COOL_FRAMES frames.
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
  const firstRepaint = frames.findIndex((s, f) => s.repaintMs > 0 && (!leg.lod || leg.cut[f] === true));
  const { stray, grows } = attributeCreates(segments.slice(firstRepaint + 1).flat());
  expect(stray, "GPU objects created per streamed frame").toBe(0);
  for (const g of grows) {
    expect(g.after, `an instanced lane grew from ${g.before} to ${g.after} instances, less than double`).toBeGreaterThanOrEqual(2 * g.before);
  }

  // Repaints throttled to ≥ minFrameMs apart (the final one, which always paints, excepted).
  const repaints = frames.filter((s) => s.repaintMs > 0).map((s) => s.now);
  for (let i = 1; i < repaints.length - 1; i++) {
    expect((repaints[i] ?? 0) - (repaints[i - 1] ?? 0)).toBeGreaterThanOrEqual(MIN_FRAME_MS - 2);
  }

  // settled only after the final positions were harvested.
  const finalHarvest = frames.findIndex((s) => s.harvestedTicks === ITERATIONS);
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
    const sliced = new Set([60, 120].map((hz) => staticBands(N, frameBudgetMs(DEFAULT_BUDGET_MS, 1000 / hz), solo.atlasRows)));
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

function report(label: string, leg: Leg): { transport: number[]; encode: number[]; ticksPerSec: number } {
  const { frames } = leg;
  const transport = frames.map((s) => s.harvestMs + s.encodeMs);
  const encode = frames.map((s) => s.encodeMs);
  const repaint = frames.filter((s) => s.repaintMs > 0).map((s) => s.repaintMs);
  const intervals = frames.slice(1).map((s, i) => s.now - (frames[i]?.now ?? s.now));
  const first = frames[0]?.now ?? 0;
  const last = frames[frames.length - 1]?.now ?? first;
  const ticksPerSec = (ITERATIONS / Math.max(1, last - first)) * 1000;
  console.log(
    `  GPU stream [${label}] N=${N}: ${frames.length} frames, ${repaint.length} repaints, ` +
      `transport ms/frame median ${median(transport).toFixed(2)} p95 ${quantile(transport, 0.95).toFixed(2)} max ${Math.max(...transport).toFixed(2)}; ` +
      `encode median ${median(encode).toFixed(2)} p95 ${quantile(encode, 0.95).toFixed(2)}; ` +
      `repaint ms median ${median(repaint).toFixed(1)} max ${Math.max(0, ...repaint).toFixed(1)}; ` +
      `rAF interval median ${median(intervals).toFixed(1)} ms; ${ticksPerSec.toFixed(1)} ticks/s; ` +
      `${ITERATIONS} ticks in ${leg.elapsedMs.toFixed(0)} ms; bands ${frames[frames.length - 1]?.bands}, blocked ${frames.filter((s) => s.blocked).length}`,
  );
  return { transport, encode, ticksPerSec };
}

/** The drag leg's signatures: the transport's per-frame contract holds through the drag, and the pins are O(held). */
function assertDrag(label: string, leg: DragLeg, transportP95Ms: number, encodeMedianMs: number): void {
  const frames = [...leg.held, ...leg.cool];
  const transport = frames.map((s) => s.harvestMs + s.encodeMs);
  const encode = frames.map((s) => s.encodeMs);
  const repaints = frames.filter((s) => s.repaintMs > 0);
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

  // The transport's per-frame bounds hold through the drag and the re-cool.
  expect(quantile(transport, 0.95)).toBeLessThan(transportP95Ms);
  expect(median(encode)).toBeLessThan(encodeMedianMs);

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

/**
 * Which half of T7 a file runs. T7 runs as two files, one per reduction state, because the browser tier
 * gives each file its own process and a 300 s budget (scripts/run-browser-perf-tier.mjs). On the CI runners
 * the legs together take 140-280 s: under SwiftShader every 100k-node full-detail repaint holds the next
 * animation frame for seconds, and a drag repaints tens of times. That is past the budget on a slow runner.
 * Each half builds its own engine and fixture; only the LOD-off half measures the GPU-only tick rate its
 * throughput floor needs.
 */
export type StreamHalf = "LOD off" | "LOD on";

/** Register T7's legs for one reduction state (see {@link StreamHalf}). */
export function describeGpuStream(half: StreamHalf): void {
  const off = half === "LOD off";
  describe(`GPU layout streaming per frame (#352), ${half} — network().layout({ backend: 'gpu' })`, () => {
    let host: HTMLElement;
    let net: Network;
    let graph: NetworkGraph;
    let gpuOnlyTicksPerSec = 0;
    let gpuOnlyReport = "";

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

    it.runIf(!off)("LOD on (structural cut, declutter, super-edges): the same transport bounds; repaint cost reported", async () => {
      const leg = await streamLeg(net, graph, true);
      const { transport, encode } = report("LOD on", leg);
      assertSignatures(leg);
      expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
      expect(median(encode)).toBeLessThan(ENCODE_MEDIAN_MS);
    }, perfBudget(240_000));

    it.runIf(!off)("LOD on: a node drag reheats through the same budgeted loop — transport bounds, O(held) pins", async () => {
      const leg = await dragLeg(net, host, graph, Math.floor(N / 2));
      assertDrag("LOD on", leg, TRANSPORT_P95_MS, ENCODE_MEDIAN_MS);
    }, perfBudget(240_000));
  });
}
