import { describe, it, expect, beforeAll } from "vitest";
import { Network, type NetworkHit } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import type { ModulePathNode } from "../module-colors.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import type { InstancedLayer, InstancedHighlight, InstancedCirclesData } from "../../core/backend.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames, zoomSteps, type GlBufferUsage } from "../../__tests__/engine-sweep.js";

/**
 * Per-interaction guard for the state network's **both view** (#494, #315): containers that hover, select
 * and drag, state dots sized by the engine, and module colours resolved from the app's palette.
 *
 * That puts both-view work on five §5 paths, each driven through its REAL trigger on one engine at
 * `PERF_BROWSER_N` physical nodes:
 *   - **hover sweep across containers** (pointer moves): the container pick runs after the state-node pick,
 *     O(physical) per move. Zero base-lane (re-)emits, uniform pushes only (the container takes
 *     `u_hoverGroup = stateCount + p`, its state dots match it through `groups2`), no buffer churn, an
 *     N-independent upload per move (the hovered container's state rings).
 *   - **selection change** (`select()` of containers): zero base-lane emits; the upload is exactly the
 *     flag columns (state nodes + state links + one flag per container) plus the ring.
 *   - **zoom sweep** with a selection: the static lane never re-emits, the module colour accessor never
 *     runs, no buffer churn.
 *   - **container drag** (pointer down + moves, one engine frame per move): each frame re-emits the lane
 *     (the pre-existing no-LOD drag cost, #314) with the SAME container columns (colours, rings, groups) and
 *     the SAME `selected` flags — nothing O(physical) is rebuilt per move — and no colour accessor runs.
 *   - **streamed layout frame** (`scheduleLayoutRepaint`, what a worker/GPU layout calls per frame, with the
 *     physical positions spreading out as a converging layout does): the dot and container radii follow the
 *     scale, re-resolving the style's radii (the pre-existing per-frame restyle of this view), but the
 *     module colours are kept: zero colour-accessor calls per frame.
 *
 * **Reductions:** the both view draws every container with its state nodes (LOD applies to the state view,
 * #495), so the "LOD on" state here is an app that asked for LOD while in this view — the Navigator's order.
 * The leg pins that the request changes nothing: the full-detail lane and its containers stay, with the
 * same hover and zoom signatures. The engine keeps the request (#494 review): the **state view** leg switches
 * to it and finds that LOD drawn, then cuts the state graph's module tree, whose aggregates take their own
 * module's colour — a zoom sweep with that cut (reductions ON) and without it (OFF) asks the colour accessor
 * zero times, and over the whole run every module path is asked exactly once.
 *
 * The app's style is the Navigator's `sizeMode: "screen"`: the both view's nodes stay world-sized and its links
 * keep px widths (#494 review), so every both-view leg runs the px-link-over-world-node path.
 *
 * ONE ENGINE for every leg — never a second WebGL engine after a large one (#287).
 */

// Physical nodes; 4 in 5 hold two state nodes in different top-level modules, every 5th one. `max` as the
// physical-view pie guard's: 100k physical nodes is ~180k state nodes, 100k containers and ~200k links.
const N = perfN(20_000, { max: 100_000 });
const COLS = Math.max(1, Math.round(Math.sqrt(N)));
const SPACING = 8;
const W = 640;
const H = 400;
/** The view the interaction legs run at: k = 4 makes a container ~8 px across. */
const K = 4;
const HOVER_ROWS = 8;
const HOVER_COLS = 16;
const DRAG_MOVES = 8;
const STREAM_FRAMES = 6;
/** The base network lane's layers — a restyle must never (re)emit any of these. */
const BASE_LANE = ["nodes", "links", "arrows", "node-halos", "phys-container", "pie"] as const;
// Upload allowed per hover change / per zoom frame: the ring overlay (a few circles). ABSOLUTE and
// N-independent: a container re-upload alone is ~36 B × N physical, ~720 kB at the local default.
const RING_BYTES_PER_EVENT = 4 * 1024;
const SELECT_SLACK_BYTES = 16 * 1024;
// Wall-clock ceilings, split constant + linear (docs/agents/performance.md §Scaling a guard), calibrated on local
// headless Chromium (SwiftShader, M1 Max), medians at 20k / 100k physical nodes:
// - a hover move is two CPU picks (state nodes, then containers: the linear term) + a ring emit + uniform
//   writes: 0.3 / 0.7 ms → 1.5 / 3.5 ms ceilings (~5x);
// - a drag move re-emits the whole no-LOD lane (O(state nodes + links + containers), #314): 0.5 / 3.9 ms →
//   6 / 22 ms (5.6x at 100k, where the linear term carries it);
// - a streamed frame re-derives the rosette, re-sizes the radii, re-resolves the style's radii and re-emits the
//   lane: 2.2 / 12.9 ms → 16 / 64 ms (~5-7x). A colour re-resolution per frame is the deterministic check's job.
const HOVER_MS = perfBudget(1 + (0.5 * N) / 20_000);
const DRAG_MOVE_MS = perfBudget(2 + (4 * N) / 20_000);
const STREAM_FRAME_MS = perfBudget(4 + (12 * N) / 20_000);
// - a state-view zoom frame (#494 review) with module LOD re-cuts the state graph's module tree and emits the
//   frontier: worst 4.5 / 8.6 ms → 25 / 45 ms (~5x); with LOD off the static lane writes a uniform: 0.0 / 0.0 ms,
//   the static-emit ceiling of the other network guards.
const STATE_LOD_FRAME_MS = perfBudget(20 + (5 * N) / 20_000);
const STATE_OFF_FRAME_MS = perfBudget(4 + (4 * N) / 20_000);
const SETUP_MS = perfBudget(120_000 + N / 2);

/** A network whose streamed layout frame a guard can drive itself (the protected seam a real stream calls). */
class StreamProbe extends Network {
  streamFrame(): void {
    this.scheduleLayoutRepaint();
  }
}

/** Counts the instanced-layer calls reaching the WebGL backend by layer name, and keeps the container
 *  columns of each container emit (by reference only). */
class LaneCallSpy {
  readonly emits = new Map<string, number>();
  readonly styles = new Map<string, number>();
  readonly live = new Set<string>();
  containerEmits: InstancedCirclesData[] = [];
  containerStyles: InstancedHighlight[] = [];
  styleFlagBytes = 0;
  private readonly origSet = WebGLBackend.prototype.setInstancedLayer;
  private readonly origUpdate = WebGLBackend.prototype.updateInstancedLayer;
  private readonly origRemove = WebGLBackend.prototype.removeInstancedLayer;
  private readonly origStyle = WebGLBackend.prototype.styleInstancedLayer;

  constructor() {
    const spy = this;
    const { origSet, origUpdate, origRemove, origStyle } = this;
    const onEmit = (layer: InstancedLayer): void => {
      spy.emits.set(layer.name, (spy.emits.get(layer.name) ?? 0) + 1);
      if (layer.name === "phys-container" && layer.primitive === "circles") spy.containerEmits.push(layer.circles);
    };
    WebGLBackend.prototype.setInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
      onEmit(layer);
      spy.live.add(layer.name);
      origSet.call(this, layer);
    };
    WebGLBackend.prototype.updateInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
      onEmit(layer);
      spy.live.add(layer.name);
      origUpdate.call(this, layer);
    };
    WebGLBackend.prototype.removeInstancedLayer = function (this: WebGLBackend, name: string): void {
      spy.live.delete(name);
      origRemove.call(this, name);
    };
    WebGLBackend.prototype.styleInstancedLayer = function (this: WebGLBackend, name: string, h: InstancedHighlight): void {
      spy.styles.set(name, (spy.styles.get(name) ?? 0) + 1);
      if (name === "phys-container") spy.containerStyles.push(h);
      if (h.selected && spy.live.has(name)) spy.styleFlagBytes += h.selected.length * 4;
      origStyle.call(this, name, h);
    };
  }
  baseEmits(): number {
    let n = 0;
    for (const name of BASE_LANE) n += this.emits.get(name) ?? 0;
    return n;
  }
  totalStyles(): number {
    let n = 0;
    for (const v of this.styles.values()) n += v;
    return n;
  }
  reset(): void {
    this.emits.clear();
    this.styles.clear();
    this.containerEmits = [];
    this.containerStyles = [];
    this.styleFlagBytes = 0;
  }
  restore(): void {
    WebGLBackend.prototype.setInstancedLayer = this.origSet;
    WebGLBackend.prototype.updateInstancedLayer = this.origUpdate;
    WebGLBackend.prototype.removeInstancedLayer = this.origRemove;
    WebGLBackend.prototype.styleInstancedLayer = this.origStyle;
  }
}

/** A grid of N physical nodes; 4 in 5 hold two state nodes in different top-level modules. */
function fixture(n: number) {
  const stateToPhysical: number[] = [];
  const modules: ModulePathNode[] = [];
  const first = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    first[p] = stateToPhysical.length;
    modules.push({ id: stateToPhysical.length, path: [1 + (p % 3), 1 + (p % 7), 1] });
    stateToPhysical.push(p);
    if (p % 5 !== 4) {
      modules.push({ id: stateToPhysical.length, path: [1 + ((p + 1) % 3), 1 + (p % 5), 2] });
      stateToPhysical.push(p);
    }
  }
  const source: number[] = [];
  const target: number[] = [];
  for (let p = 0; p < n; p++) {
    if ((p + 1) % COLS !== 0 && p + 1 < n) { source.push(first[p] ?? 0); target.push(first[p + 1] ?? 0); }
    if (p + COLS < n) { source.push(first[p] ?? 0); target.push(first[p + COLS] ?? 0); }
  }
  const graph = buildStateGraph({ stateCount: stateToPhysical.length, stateToPhysical, source, target, directed: false });
  const positions = new Float32Array(n * 2);
  for (let p = 0; p < n; p++) {
    positions[2 * p] = (p % COLS) * SPACING;
    positions[2 * p + 1] = Math.floor(p / COLS) * SPACING;
  }
  return { graph, modules, positions };
}

interface EventLeg { events: number; baseEmits: number; styles: number; containerHover: number; gpu: GlBufferUsage; worstMs: number; medianMs: number }

let stateCount = 0;
let stateEdges = 0;
let modulesWithNodes = 0;
let containersLive = false;
let colorCallsAtBuild = 0;
let targetsAreContainers = 0;
let hoverOff: EventLeg;
let selectOff: EventLeg & { flagBytes: number; containerFlags: number };
let zoomOff: { baseEmits: number; colorCalls: number; gpu: GlBufferUsage; frames: number };
let dragOff: { moves: number; containerEmits: number; sameColumns: boolean; sameSelected: boolean; colorCalls: number; moved: boolean; worstMs: number; medianMs: number };
let streamOff: { frames: number; colorCalls: number; containerEmits: number; radiiChanged: boolean; worstMs: number; medianMs: number };
let lodAsked: { containersLive: boolean; nodesLive: boolean; hover: EventLeg; zoomBaseEmits: number; colorCalls: number };
let stateView: {
  remembered: string;
  source: string;
  callsAtLod: number;
  lod: { calls: number; worstMs: number; frames: number; gpu: GlBufferUsage };
  off: { calls: number; baseEmits: number; worstMs: number; gpu: GlBufferUsage };
};
let colorCallsTotal = 0;
let modulesAsked = 0;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor(s.length / 2)] ?? 0) : 0;
};

beforeAll(async () => {
  const gl = new GlBufferSpy();
  const lane = new LaneCallSpy();
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  try {
    const fx = fixture(N);
    stateCount = fx.graph.state.nodeCount;
    stateEdges = fx.graph.state.edgeCount;
    let colorCalls = 0;
    const seen = new Set<string>();
    const color = (path: readonly number[]): string => {
      colorCalls++;
      seen.add(path.join(":"));
      return ["#d62728", "#1f77b4", "#2ca02c"][(path[0] ?? 1) - 1] ?? "#999999";
    };
    const h = perfHost(W, H);
    const net = new StreamProbe(h, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    net
      // The Navigator's screen sizeMode: the both view's nodes stay world-sized, its links px-sized (#494 review).
      .style({ nodeFill: { by: "module", color }, linkStroke: "rgba(90,110,150,0.5)", sizeMode: "screen" })
      .stateNetwork(fx.graph, { modules: fx.modules, view: "both" })
      .layout({ backend: "positions", positions: fx.positions });
    net.setTransform({ k: K, x: 0, y: 0 });
    net.interactive({ selectable: { multi: true }, draggable: true, hover: { others: { opacity: 0.5 } } });
    net.toPNG(); // drain the first draw
    containersLive = lane.live.has("phys-container");
    colorCallsAtBuild = colorCalls;
    modulesWithNodes = seen.size;

    const r = h.getBoundingClientRect();
    const move = (x: number, y: number) =>
      h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
    const isContainer = (x: number, y: number, p: number): boolean => {
      const d = net.pick(x, y)?.datum as NetworkHit | undefined;
      return d?.level === "physical" && d.physical === p;
    };
    /** A screen point on physical `p`'s container but off its state dots: up from its centre, past the dots. */
    const containerTarget = (p: number): [number, number] => {
      const x = (p % COLS) * SPACING * K, y = Math.floor(p / COLS) * SPACING * K;
      for (let d = 0.25; d < SPACING * K; d += 0.25) if (isContainer(x, y - d, p)) return [x, y - d];
      return [x, y];
    };
    const targets: [number, number][] = [];
    const targetIds: number[] = [];
    for (let row = 1; row <= HOVER_ROWS; row++) {
      for (let col = 1; col <= HOVER_COLS; col++) {
        const p = row * COLS + col;
        targets.push(containerTarget(p));
        targetIds.push(p);
      }
    }
    targetsAreContainers = targets.filter(([x, y], i) => isContainer(x, y, targetIds[i] ?? -1)).length;
    const gap: [number, number] = [W - 2, H - 2];

    const hoverSweep = (points: readonly (readonly [number, number])[]): EventLeg => {
      const [x0, y0] = points[0] ?? [0, 0];
      move(x0, y0);
      lane.reset();
      const before = gl.mark();
      const times: number[] = [];
      for (let j = 1; j < points.length; j++) {
        const [x, y] = points[j] ?? [0, 0];
        const t0 = performance.now();
        move(x, y);
        times.push(performance.now() - t0);
      }
      const leg: EventLeg = {
        events: points.length - 1,
        baseEmits: lane.baseEmits(),
        styles: lane.totalStyles(),
        containerHover: lane.containerStyles.filter((u) => (u.hoverGroup ?? -1) >= stateCount).length,
        gpu: gl.since(before),
        worstMs: Math.max(...times),
        medianMs: median(times),
      };
      move(gap[0], gap[1]);
      return leg;
    };

    // ── Full detail (the both view's only lane) ──────────────────────────────────────────────────
    hoverOff = hoverSweep(targets);

    {
      const picks = [stateCount + targetIds[3]!, stateCount + targetIds[20]!, stateCount + targetIds[41]!];
      net.select("nodes", [stateCount + targetIds[60]!]); // warm-up: the ring layer appears
      lane.reset();
      const before = gl.mark();
      const times: number[] = [];
      for (const id of picks) {
        const t0 = performance.now();
        net.select("nodes", [id]);
        times.push(performance.now() - t0);
      }
      let lastFlags: Uint8Array | undefined;
      for (const u of lane.containerStyles) if (u.selected) lastFlags = u.selected;
      let sum = 0;
      if (lastFlags) for (const f of lastFlags) sum += f;
      selectOff = {
        events: picks.length,
        baseEmits: lane.baseEmits(),
        styles: lane.totalStyles(),
        containerHover: 0,
        gpu: gl.since(before),
        worstMs: Math.max(...times),
        medianMs: median(times),
        flagBytes: lane.styleFlagBytes,
        containerFlags: lastFlags?.length === N ? sum : -1,
      };
    }

    {
      const colorBefore = colorCalls;
      lane.reset();
      const before = gl.mark();
      const { frames } = sweepFrames(zoomSteps(W, H, [1, 2, 4, 8, 16]), (t) => net.setTransform(t));
      zoomOff = { baseEmits: lane.baseEmits(), colorCalls: colorCalls - colorBefore, gpu: gl.since(before), frames };
      net.setTransform({ k: K, x: 0, y: 0 });
    }

    // Engine frames by hand for the drag and the stream: one queued animation frame per move / per frame.
    const queued = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const flush = (): void => {
      const due = [...queued.values()];
      queued.clear();
      const now = performance.now();
      for (const cb of due) cb(now);
    };
    globalThis.requestAnimationFrame = (cb) => {
      queued.set(++frameId, cb);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => void queued.delete(id);

    {
      const grabbed = targetIds[50]!;
      const [gx, gy] = targets[50]!;
      net.select("nodes", [stateCount + grabbed]);
      flush();
      lane.reset();
      const colorBefore = colorCalls;
      const x0 = fx.graph.physical.positions[2 * grabbed]!;
      const times: number[] = [];
      const ev = (type: string, x: number, y: number) =>
        h.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
      ev("pointerdown", gx, gy);
      for (let m = 1; m <= DRAG_MOVES; m++) {
        const t0 = performance.now();
        ev("pointermove", gx + 4 * m, gy + 3 * m);
        flush();
        times.push(performance.now() - t0);
      }
      ev("pointerup", gx + 4 * DRAG_MOVES, gy + 3 * DRAG_MOVES);
      for (let f = 0; f < 4; f++) flush();
      const emits = lane.containerEmits;
      const head = emits[0];
      dragOff = {
        moves: DRAG_MOVES,
        containerEmits: emits.length,
        sameColumns: !!head && emits.every((c) => c.colors === head.colors && c.borders === head.borders && c.groups === head.groups && c.radii === head.radii),
        sameSelected: !!head?.selected && emits.every((c) => c.selected === head.selected),
        colorCalls: colorCalls - colorBefore,
        moved: Math.abs(fx.graph.physical.positions[2 * grabbed]! - x0 - (4 * DRAG_MOVES) / K) < 1e-3,
        worstMs: Math.max(...times),
        medianMs: median(times),
      };
      net.select("nodes", null);
      flush();
    }

    {
      // A converging layout spreads out frame by frame: scale the physical positions up a little per frame,
      // as a worker frame writes them, then let the stream's repaint run.
      lane.reset();
      const colorBefore = colorCalls;
      const pos = fx.graph.physical.positions;
      const times: number[] = [];
      let radii: Float32Array | undefined;
      let radiiChanged = false;
      for (let f = 1; f <= STREAM_FRAMES; f++) {
        for (let i = 0; i < pos.length; i++) pos[i] = pos[i]! * 1.02;
        const t0 = performance.now();
        net.streamFrame();
        flush();
        times.push(performance.now() - t0);
        const last = lane.containerEmits[lane.containerEmits.length - 1];
        if (radii && last && last.radii !== radii) radiiChanged = true;
        radii = last?.radii;
      }
      streamOff = {
        frames: STREAM_FRAMES,
        colorCalls: colorCalls - colorBefore,
        containerEmits: lane.containerEmits.length,
        radiiChanged,
        worstMs: Math.max(...times),
        medianMs: median(times),
      };
    }
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;

    // ── LOD asked for in the both view (the Navigator's order) ──────────────────────────────────────
    {
      net.layout({ backend: "positions", positions: fixture(N).positions });
      net.setTransform({ k: K, x: 0, y: 0 });
      lane.reset();
      const colorBefore = colorCalls;
      net.lod({ declutter: true, maxAggregateRadius: 24 });
      const live = lane.live.has("phys-container");
      const nodesLive = lane.live.has("nodes");
      const hover = hoverSweep(targets);
      lane.reset();
      sweepFrames(zoomSteps(W, H, [1, 2, 4, 8, 16]), (t) => net.setTransform(t));
      lodAsked = { containersLive: live, nodesLive, hover, zoomBaseEmits: lane.baseEmits(), colorCalls: colorCalls - colorBefore };
    }

    // ── The state view (#494 review): the request made in the both view applies on the switch, and a module cut
    //    colours its aggregates by their own modules, resolved once per (tree, style), never per frame ─────────
    {
      net.view("state");
      const remembered = net.lodSource;
      const atLod = colorCalls;
      net.lod({ modules: fx.modules, declutter: true });
      const callsAtLod = colorCalls - atLod;
      const source = net.lodSource;
      const steps = zoomSteps(W, H, [0.25, 0.5, 1, 2, 4, 8, 16]);
      sweepFrames(steps, (t) => net.setTransform(t), 1); // warm
      let before = gl.mark();
      let c0 = colorCalls;
      const lodSweep = sweepFrames(steps, (t) => net.setTransform(t));
      const lodLeg = { calls: colorCalls - c0, worstMs: lodSweep.worstFrameMs, frames: lodSweep.frames, gpu: gl.since(before) };
      net.lod(false);
      sweepFrames(steps, (t) => net.setTransform(t), 1);
      lane.reset();
      before = gl.mark();
      c0 = colorCalls;
      const offSweep = sweepFrames(steps, (t) => net.setTransform(t));
      stateView = { remembered, source, callsAtLod, lod: lodLeg, off: { calls: colorCalls - c0, baseEmits: lane.baseEmits(), worstMs: offSweep.worstFrameMs, gpu: gl.since(before) } };
    }
    colorCallsTotal = colorCalls;
    modulesAsked = seen.size;
    net.destroy();
    h.remove();
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
    lane.restore();
    gl.restore();
  }
}, SETUP_MS);

describe(`state-network both view — per-interaction cost at N=${N.toLocaleString()} physical nodes (#494)`, () => {
  it("builds real containers, and asks the colour accessor once per module (non-vacuity)", () => {
    console.info(
      `[both-perf N=${N}] hover median ${hoverOff.medianMs.toFixed(2)} ms (worst ${hoverOff.worstMs.toFixed(2)}), ` +
        `drag ${dragOff.medianMs.toFixed(2)} ms (worst ${dragOff.worstMs.toFixed(2)}), stream ${streamOff.medianMs.toFixed(2)} ms (worst ${streamOff.worstMs.toFixed(2)}), ` +
        `select ${selectOff.medianMs.toFixed(2)} ms, LOD-asked hover ${lodAsked.hover.medianMs.toFixed(2)} ms`,
    );
    expect(containersLive, "the fixture drew no container layer").toBe(true);
    expect(targetsAreContainers, "a hover target does not pick its container").toBe(HOVER_ROWS * HOVER_COLS);
    // State level + pie level, each module once: never once per node.
    expect(colorCallsAtBuild, "the module colour accessor ran per node").toBeLessThanOrEqual(2 * modulesWithNodes);
    expect(stateCount, "the fixture has too few state nodes").toBeGreaterThan(N);
  });

  it("hover sweep across containers: uniforms only, no geometry, an N-independent upload", () => {
    expect(hoverOff.baseEmits, "a container hover re-emitted base-lane geometry").toBe(0);
    expect(hoverOff.containerHover, "the containers never received their hover group").toBeGreaterThanOrEqual(hoverOff.events);
    expect(hoverOff.gpu.created, "a hover created GPU buffers").toBe(0);
    expect(hoverOff.gpu.deleted, "a hover destroyed GPU buffers").toBe(0);
    expect(hoverOff.gpu.uploadedBytes / hoverOff.events, "hover upload per move is not the ring's few bytes").toBeLessThan(RING_BYTES_PER_EVENT);
    expect(hoverOff.medianMs, `hover median ${hoverOff.medianMs.toFixed(2)}ms (worst ${hoverOff.worstMs.toFixed(2)}ms)`).toBeLessThan(HOVER_MS);
  });

  it("selection change: exactly the flag columns (state nodes, state links, containers) + the ring", () => {
    expect(selectOff.baseEmits, "a selection re-emitted base-lane geometry").toBe(0);
    expect(selectOff.containerFlags, "the selected container is not the one flagged").toBe(1);
    expect(selectOff.flagBytes / selectOff.events, "flag bytes per selection are not 4 B per state node + state link + container").toBe(4 * (stateCount + stateEdges + N));
    expect(selectOff.gpu.uploadedBytes).toBeLessThanOrEqual(selectOff.flagBytes + SELECT_SLACK_BYTES * selectOff.events);
  });

  it("zoom sweep with a selection: the static lane never re-emits, no colour accessor runs", () => {
    expect(zoomOff.baseEmits, "the both view's lane re-emitted during the zoom sweep").toBe(0);
    expect(zoomOff.colorCalls, "the module colours were resolved again per frame").toBe(0);
    expect(zoomOff.gpu.created).toBe(0);
    expect(zoomOff.gpu.deleted).toBe(0);
    expect(zoomOff.gpu.uploadedBytes / zoomOff.frames).toBeLessThan(RING_BYTES_PER_EVENT);
  });

  it("container drag: each frame re-emits the SAME container columns and flags; no colour accessor runs", () => {
    expect(dragOff.moved, "the grabbed container's physical node did not follow the pointer").toBe(true);
    expect(dragOff.containerEmits, "the drag did not re-emit the containers once per move").toBeGreaterThanOrEqual(dragOff.moves);
    expect(dragOff.sameColumns, "a drag frame rebuilt the container columns").toBe(true);
    expect(dragOff.sameSelected, "a drag frame rebuilt the container flags").toBe(true);
    expect(dragOff.colorCalls, "a drag frame resolved the module colours again").toBe(0);
    expect(dragOff.medianMs, `drag move median ${dragOff.medianMs.toFixed(2)}ms (worst ${dragOff.worstMs.toFixed(2)}ms)`).toBeLessThan(DRAG_MOVE_MS);
  });

  it("streamed layout frame: radii follow the scale, the module colours are kept (no accessor per frame)", () => {
    expect(streamOff.containerEmits, "the stream did not repaint once per frame").toBeGreaterThanOrEqual(streamOff.frames);
    expect(streamOff.radiiChanged, "the radii did not follow the spreading layout — the leg is vacuous").toBe(true);
    expect(streamOff.colorCalls, "a streamed frame resolved the module colours again").toBe(0);
    expect(streamOff.medianMs, `stream frame median ${streamOff.medianMs.toFixed(2)}ms (worst ${streamOff.worstMs.toFixed(2)}ms)`).toBeLessThan(STREAM_FRAME_MS);
  });

  it("LOD asked for in the both view: the full-detail lane and its containers stay, same signatures", () => {
    expect(lodAsked.containersLive, "lod() dropped the containers").toBe(true);
    expect(lodAsked.nodesLive).toBe(true);
    expect(lodAsked.hover.baseEmits, "a hover re-emitted base geometry").toBe(0);
    expect(lodAsked.hover.containerHover).toBeGreaterThanOrEqual(lodAsked.hover.events);
    expect(lodAsked.hover.gpu.uploadedBytes / lodAsked.hover.events).toBeLessThan(RING_BYTES_PER_EVENT);
    expect(lodAsked.zoomBaseEmits, "a zoom re-emitted the lane").toBe(0);
    expect(lodAsked.colorCalls).toBe(0);
    expect(lodAsked.hover.medianMs).toBeLessThan(HOVER_MS);
  });

  it("state view: the LOD asked for in the both view applies on the switch (#494 review, 2)", () => {
    expect(stateView.remembered, "the state view came back without the app's LOD").not.toBe("none");
    expect(stateView.source).toBe("modules");
  });

  it("state view, module LOD: aggregates take their own module colour, resolved once per module, none per frame", () => {
    // Every module path is asked once over the whole run — state dots, physical discs, pies and aggregates.
    expect(colorCallsTotal, "a module colour was asked more than once").toBe(modulesAsked);
    expect(stateView.callsAtLod, "the cut's modules were never resolved: the leg is vacuous").toBeGreaterThan(0);
    expect(stateView.lod.calls, "a zoom frame asked the colour accessor (reductions ON)").toBe(0);
    expect(stateView.lod.gpu.created, "the LOD sweep churned GPU buffers").toBeLessThan(64);
    expect(stateView.lod.worstMs, `LOD zoom frame ${stateView.lod.worstMs.toFixed(2)}ms`).toBeLessThan(STATE_LOD_FRAME_MS);
    expect(stateView.off.calls, "a zoom frame asked the colour accessor (reductions OFF)").toBe(0);
    expect(stateView.off.baseEmits, "a full-detail zoom re-emitted the lane").toBe(0);
    expect(stateView.off.gpu.created).toBe(0);
    expect(stateView.off.worstMs, `full-detail zoom frame ${stateView.off.worstMs.toFixed(2)}ms`).toBeLessThan(STATE_OFF_FRAME_MS);
  });
});
