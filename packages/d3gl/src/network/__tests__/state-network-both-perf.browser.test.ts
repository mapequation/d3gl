import { describe, it, expect, beforeAll } from "vitest";
import { Network, type NetworkHit } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import { DRAG_HEAT, ForceLayout } from "../force.js";
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
 *     physical positions spreading out as a converging layout does): the state nodes' anchors are copied in
 *     place, and nothing style-derived changes (#509: the radii are the app's spec, packed once per style), so
 *     no style re-resolve and zero colour-accessor calls per frame.
 *
 * **Reductions:** the both view draws every container with its state nodes (LOD applies to the state view,
 * #495), so the "LOD on" state here is an app that asked for LOD while in this view — the Navigator's order.
 * The leg pins that the request changes nothing: the full-detail lane and its containers stay, with the
 * same hover and zoom signatures. The engine keeps the request (#494 review): the **state view** leg switches
 * to it and finds that LOD drawn, then cuts the state graph's module tree, whose aggregates take their own
 * module's colour — a zoom sweep with that cut (reductions ON) and without it (OFF) asks the colour accessor
 * zero times, and over the whole run every module path is asked exactly once.
 *
 * The app's style is the Navigator's `sizeMode: "screen"`: the both view draws its state nodes, physical nodes and
 * links in px (#509), each state node at its physical node plus a px offset column.
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
// - a streamed frame copies the state nodes' anchors and re-emits the lane (#509: no re-sizing, no style re-resolve
//   since): 2.2 / 12.9 ms → 16 / 64 ms (~5-7x), calibrated before #509, which only removed work. A colour re-resolution per frame is the deterministic check's job.
const HOVER_MS = perfBudget(1 + (0.5 * N) / 20_000);
const DRAG_MOVE_MS = perfBudget(2 + (4 * N) / 20_000);
const STREAM_FRAME_MS = perfBudget(4 + (12 * N) / 20_000);
// - a state-view zoom frame (#494 review) with module LOD re-cuts the state graph's module tree and emits the
//   frontier: worst 4.5 / 8.6 ms → 25 / 45 ms (~5x); with LOD off the static lane writes a uniform: 0.0 / 0.0 ms,
//   the static-emit ceiling of the other network guards.
const STATE_LOD_FRAME_MS = perfBudget(20 + (5 * N) / 20_000);
// - a reheating drag frame (#495) is one force tick over the layout's graph (O(nodes) Barnes-Hut) plus the lane re-emit:
//   calibrated below; the container drag is held to the physical view's drag of the same node, ×REHEAT_RATIO + slack.
const REHEAT_MOVE_MS = perfBudget(40 + (60 * N) / 20_000);
const REHEAT_RATIO = 2;
const REHEAT_SLACK_MS = perfBudget(4 + (8 * N) / 20_000);
// - the state view's drag against the same drag on `data(stateGraph, { modules })` (#495 review): the same code, so
//   within noise; 1.25× + slack absorbs run-to-run spread.
const STATE_PLAIN_RATIO = 1.25;
const STATE_PLAIN_SLACK_MS = perfBudget(2 + (2 * N) / 20_000);
const STATE_OFF_FRAME_MS = perfBudget(4 + (4 * N) / 20_000);
const SETUP_MS = perfBudget(120_000 + N / 2);

/** A network whose streamed layout frame a guard can drive itself (the protected seam a real stream calls). */
class StreamProbe extends Network {
  streamFrame(): void {
    this.scheduleLayoutRepaint();
  }
  /** `render()` calls, and with `countOnly` set they are counted, not submitted (#495 review): the reheating drag
   *  legs measure the drag's CPU work (a force tick over every node, the lane emit, the uploads), and their
   *  full-detail frames would queue minutes of software-GL work that stalls a later call (LOG.md, "Local headless
   *  Chromium rasterises on SwiftShader"). The other legs draw. */
  renders = 0;
  countOnly = false;
  override render(): this {
    this.renders++;
    return this.countOnly ? this : super.render();
  }
}

/** Counts the instanced-layer calls reaching the WebGL backend by layer name, and keeps the container
 *  columns of each container emit (by reference only). */
class LaneCallSpy {
  readonly emits = new Map<string, number>();
  readonly styles = new Map<string, number>();
  readonly live = new Set<string>();
  containerEmits: InstancedCirclesData[] = [];
  nodeEmits: InstancedCirclesData[] = [];
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
      if (layer.name === "nodes" && layer.primitive === "circles") spy.nodeEmits.push(layer.circles);
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
    this.nodeEmits = [];
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
let streamOff: { frames: number; colorCalls: number; containerEmits: number; radiiChanged: boolean; restyles: number; sameCenters: boolean; worstMs: number; medianMs: number };
/** A drag that reheats a force layout (#495): a both-view container drag, and the physical view's drag of the same node. */
interface ReheatLeg { moves: number; renders: number; othersMoved: number; dotsFollow: boolean; sameColumns: boolean; colorCalls: number; worstMs: number; medianMs: number }
let containerReheat: ReheatLeg;
/** A both-view drag of one state dot (#495 review): it moves inside its container, clamped to its disc. */
let dotDrag: { moves: number; moved: boolean; colorCalls: number; sameContainerColumns: boolean; sameCenters: boolean; inside: boolean; physicalMoved: boolean; worstMs: number; medianMs: number };
let physicalReheat: ReheatLeg;
/** The state view's drag (#495): the plain network's, over the state graph — with its module LOD on and off. */
let stateDrag: { off: ReheatLeg; lod: ReheatLeg };
/** The baseline (#495 review): the same drag on the plain network `data(stateGraph, { modules })` on this engine, and
 *  what the state view's drag frame is made of — one force tick over the state graph, and the rest of the frame (the
 *  same drag translating, no tick). */
let plainDrag: { off: ReheatLeg; lod: ReheatLeg };
let dragParts: { tickMs: number; translateOffMs: number; translateLodMs: number };
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
    let stateDragStart = new Float32Array(0);
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
      // The Navigator's screen sizeMode: the both view's state and physical nodes are px-sized too (#509).
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
      // One state dot of a container, dragged far out of it (#495 review): O(held) per move, clamped to its disc.
      const p = targetIds[60]!;
      const s = fx.graph.physicalToState.states[fx.graph.physicalToState.offsets[p]!]!;
      const dots = net.positions ?? new Float32Array(0);
      const physBefore = Float32Array.from(fx.graph.physical.positions);
      const gx = dots[2 * s]! * K, gy = dots[2 * s + 1]! * K;
      const sx0 = dots[2 * s]!, sy0 = dots[2 * s + 1]!;
      lane.reset();
      const colorBefore = colorCalls;
      const times: number[] = [];
      const ev = (type: string, x: number, y: number) =>
        h.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
      ev("pointerdown", gx, gy);
      for (let m = 1; m <= DRAG_MOVES; m++) {
        const t0 = performance.now();
        ev("pointermove", gx + 6 * m, gy + 4 * m);
        flush();
        times.push(performance.now() - t0);
      }
      ev("pointerup", gx + 6 * DRAG_MOVES, gy + 4 * DRAG_MOVES);
      flush();
      const emits = lane.containerEmits;
      const nodes = lane.nodeEmits;
      const pos = net.positions ?? new Float32Array(0);
      const phys = fx.graph.physical.positions;
      // Inside its container: the container's radius from its emitted column (the dots' radii are smaller).
      const radius = emits[emits.length - 1]?.radii[p] ?? 0;
      let physicalMoved = false;
      for (let i = 0; i < physBefore.length; i++) if (physBefore[i] !== phys[i]) physicalMoved = true;
      dotDrag = {
        moves: DRAG_MOVES,
        moved: Math.hypot(pos[2 * s]! - sx0, pos[2 * s + 1]! - sy0) > 0.1,
        colorCalls: colorCalls - colorBefore,
        sameContainerColumns: emits.length > 0 && emits.every((c) => c.colors === emits[0]!.colors && c.borders === emits[0]!.borders && c.radii === emits[0]!.radii),
        sameCenters: nodes.length > 0 && nodes.every((c) => c.centers === nodes[0]!.centers),
        inside: radius > 0 && Math.hypot(pos[2 * s]! - phys[2 * p]!, pos[2 * s + 1]! - phys[2 * p + 1]!) < radius,
        physicalMoved,
        worstMs: Math.max(...times),
        medianMs: median(times),
      };
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
      let dotRadii: Float32Array | undefined;
      let restyles = 0;
      let centers: Float32Array | undefined;
      let sameCenters = true;
      for (let f = 1; f <= STREAM_FRAMES; f++) {
        for (let i = 0; i < pos.length; i++) pos[i] = pos[i]! * 1.02;
        const t0 = performance.now();
        net.streamFrame();
        flush();
        times.push(performance.now() - t0);
        const last = lane.containerEmits[lane.containerEmits.length - 1];
        if (radii && last && last.radii !== radii) radiiChanged = true;
        radii = last?.radii;
        // A re-resolved style hands the state nodes a new radii column: count them (#509: never on a streamed frame).
        const dots = lane.nodeEmits[lane.nodeEmits.length - 1];
        if (dotRadii && dots && dots.radii !== dotRadii) restyles++;
        dotRadii = dots?.radii;
        if (centers && dots && dots.centers !== centers) sameCenters = false;
        centers = dots?.centers;
      }
      streamOff = {
        frames: STREAM_FRAMES,
        colorCalls: colorCalls - colorBefore,
        containerEmits: lane.containerEmits.length,
        radiiChanged,
        restyles,
        sameCenters,
        worstMs: Math.max(...times),
        medianMs: median(times),
      };
    }
    // ── Drags that reheat a force layout (#495): a both-view container drag reheats the physical layout, as the
    //    physical view's drag of the same node does — the baseline the container drag is measured against ─────
    /** Drag screen point (x, y) by DRAG_MOVES moves of (4, 3) px, one engine frame per move, then run the re-cool. */
    const reheatDrag = (x: number, y: number, held: number, both: boolean): ReheatLeg => {
      const pos = fx.graph.physical.positions;
      const before = Float32Array.from(pos);
      lane.reset();
      const colorBefore = colorCalls;
      const times: number[] = [];
      const rendersBefore = net.renders;
      net.countOnly = true;
      const ev = (type: string, px: number, py: number) =>
        h.dispatchEvent(new PointerEvent(type, { clientX: r.left + px, clientY: r.top + py, bubbles: true, button: 0, pointerId: 1 }));
      ev("pointerdown", x, y);
      for (let m = 1; m <= DRAG_MOVES; m++) {
        const t0 = performance.now();
        ev("pointermove", x + 4 * m, y + 3 * m);
        flush();
        times.push(performance.now() - t0);
      }
      const renders = net.renders - rendersBefore;
      ev("pointerup", x + 4 * DRAG_MOVES, y + 3 * DRAG_MOVES);
      // A few frames of the re-cool, not all of it. The next grab or view switch stops the loop.
      for (let f = 0; f < 3; f++) flush();
      net.countOnly = false;
      let othersMoved = 0;
      for (let p = 0; p < N; p++) if (p !== held && Math.hypot(pos[2 * p]! - before[2 * p]!, pos[2 * p + 1]! - before[2 * p + 1]!) > 1e-4) othersMoved++;
      // Each dot where its container's place puts it: inside its container's spacing of its physical node.
      let dotsFollow = true;
      const dots = net.positions;
      if (both && dots) {
        const s2p = fx.graph.stateToPhysical;
        for (let s = 0; s < stateCount; s += 97) {
          const p = s2p[s]!;
          if (Math.hypot(dots[2 * s]! - pos[2 * p]!, dots[2 * s + 1]! - pos[2 * p + 1]!) > 2 * SPACING) dotsFollow = false;
        }
      }
      const emits = lane.containerEmits;
      const head = emits[0];
      return {
        moves: DRAG_MOVES,
        renders,
        othersMoved,
        dotsFollow,
        // Kept per (radii, fill): a frame rebuilds the container columns only with new radii (a sizing step).
        sameColumns: !both || (!!head && emits.every((c, i) => i === 0 || c.radii !== emits[i - 1]!.radii || (c.colors === emits[i - 1]!.colors && c.borders === emits[i - 1]!.borders && c.groups === emits[i - 1]!.groups))),
        colorCalls: colorCalls - colorBefore,
        worstMs: Math.max(...times),
        medianMs: median(times),
      };
    };
    {
      const grabbed = targetIds[50]!;
      // The fixture's grid again, held by the force backend (a warm start of no ticks moves nothing).
      net.layout({ backend: "positions", positions: fixture(N).positions });
      net.layout({ backend: "force", warm: true, iterations: 0 });
      net.setTransform({ k: K, x: 0, y: 0 });
      flush();
      const [gx, gy] = containerTarget(grabbed);
      containerReheat = reheatDrag(gx, gy, grabbed, true);
      net.view("physical");
      net.layout({ backend: "positions", positions: fixture(N).positions });
      net.layout({ backend: "force", warm: true, iterations: 0 });
      net.setTransform({ k: K, x: 0, y: 0 });
      flush();
      physicalReheat = reheatDrag((grabbed % COLS) * SPACING * K, Math.floor(grabbed / COLS) * SPACING * K, grabbed, false);
      net.view("both");
    }
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
      // The state view holds the state modules as its hierarchy (#495): the remembered request cuts its module tree
      // on the switch, which resolves the aggregates' colours there; the explicit `modules` names the same tree.
      const atLod = colorCalls;
      net.view("state");
      const remembered = net.lodSource;
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
      // The state view's drag (#495): the plain network's force drag over the state graph, which reheats the state
      // layout — with LOD off, then with its module LOD on (every node at a zoom that opens the modules).
      net.layout({ backend: "force", warm: true, iterations: 0 });
      net.setTransform({ k: K, x: 0, y: 0 });
      flush();
      const statePos = net.positions;
      const start = Float32Array.from(statePos ?? []); // both legs drag from the same layout
      stateDragStart = start; // and so does the plain baseline below
      const grab = fx.graph.physicalToState.states[fx.graph.physicalToState.offsets[targetIds[50]!]!]!; // in view at K
      const gx = (statePos?.[2 * grab] ?? 0) * K, gy = (statePos?.[2 * grab + 1] ?? 0) * K;
      /** A screen point near (gx, gy) the drawn cut picks (a leaf or an aggregate), so the press grabs, never pans. */
      const grabPoint = (): [number, number] => {
        for (let d = 0; d < 24; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]] as const) if (net.pick(gx + dx, gy + dy)) return [gx + dx, gy + dy];
        return [gx, gy];
      };
      const stateDragLeg = (): ReheatLeg => {
        net.layout({ backend: "positions", positions: start });
        net.layout({ backend: "force", warm: true, iterations: 0 });
        net.setTransform({ k: K, x: 0, y: 0 });
        flush();
        const pos = net.positions ?? new Float32Array(0);
        const before = Float32Array.from(pos);
        const [sx, sy] = grabPoint();
        const leg = reheatDrag(sx, sy, -1, false);
        let moved = 0;
        for (let s = 0; s < stateCount; s++) if (Math.hypot(pos[2 * s]! - before[2 * s]!, pos[2 * s + 1]! - before[2 * s + 1]!) > 1e-4) moved++;
        return { ...leg, othersMoved: moved };
      };
      const off = stateDragLeg();
      net.lod({ modules: fx.modules, declutter: true });
      net.setTransform({ k: K, x: 0, y: 0 });
      flush();
      stateDrag = { off, lod: stateDragLeg() };
      // What the frame is made of: the same drag translating (the "positions" backend: no tick), LOD off and on, and
      // one drag-heat tick of the main-thread force layout over the state graph, timed alone on a copy of it.
      const translate = (): number => {
        net.layout({ backend: "positions", positions: start });
        net.setTransform({ k: K, x: 0, y: 0 });
        flush();
        const [tx, ty] = grabPoint();
        return reheatDrag(tx, ty, -1, false).medianMs;
      };
      const translateLodMs = translate();
      net.lod(false);
      const translateOffMs = translate();
      const sim = new ForceLayout({ ...fx.graph.state, positions: Float32Array.from(start) });
      sim.hold(DRAG_HEAT);
      sim.tick();
      const ticks: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        sim.tick();
        ticks.push(performance.now() - t0);
      }
      dragParts = { tickMs: median(ticks), translateOffMs, translateLodMs };
    }
    // The run's module colours are counted up to here: the plain network below resolves its own.
    colorCallsTotal = colorCalls;
    modulesAsked = seen.size;
    // ── The baseline (#495 review): the plain network over the same state graph and modules, on this engine, the
    //    same drag from the same positions ──
    {
      net.data(fx.graph.state, { modules: fx.modules });
      const statePositions = stateDragStart;
      const plainLeg = (): ReheatLeg => {
                net.layout({ backend: "positions", positions: statePositions });
        net.layout({ backend: "force", warm: true, iterations: 0 });
        net.setTransform({ k: K, x: 0, y: 0 });
        flush();
                const pos = net.positions ?? new Float32Array(0);
        const before = Float32Array.from(pos);
        const grab = fx.graph.physicalToState.states[fx.graph.physicalToState.offsets[targetIds[50]!]!]!;
        const gx = before[2 * grab]! * K, gy = before[2 * grab + 1]! * K;
        let p: [number, number] = [gx, gy];
        for (let d = 0; d < 24; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]] as const) if (!net.pick(p[0], p[1]) && net.pick(gx + dx, gy + dy)) p = [gx + dx, gy + dy];
                const leg = reheatDrag(p[0], p[1], -1, false);
        let moved = 0;
        for (let i = 0; i < stateCount; i++) if (Math.hypot(pos[2 * i]! - before[2 * i]!, pos[2 * i + 1]! - before[2 * i + 1]!) > 1e-4) moved++;
        return { ...leg, othersMoved: moved };
      };
      const off = plainLeg();
      net.lod({ modules: fx.modules, declutter: true });
      plainDrag = { off, lod: plainLeg() };
      net.lod(false);
    }
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
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

  it("dot drag (#495 review): O(held) per move, the dot clamped to its container, nothing else rebuilt", () => {
    expect(dotDrag.moved, "the dot did not move: the leg is vacuous").toBe(true);
    expect(dotDrag.inside, "the dragged dot left its container").toBe(true);
    expect(dotDrag.physicalMoved, "a dot drag moved the physical layout").toBe(false);
    expect(dotDrag.sameContainerColumns, "a dot drag rebuilt the container columns").toBe(true);
    expect(dotDrag.sameCenters, "a dot drag reallocated the dots' positions").toBe(true);
    expect(dotDrag.colorCalls, "a dot drag resolved the module colours again").toBe(0);
    expect(dotDrag.medianMs, `dot drag move median ${dotDrag.medianMs.toFixed(2)}ms (worst ${dotDrag.worstMs.toFixed(2)}ms)`).toBeLessThan(DRAG_MOVE_MS);
  });

  it("streamed layout frame: no style re-resolve, the radii and module colours are kept (no accessor per frame)", () => {
    expect(streamOff.containerEmits, "the stream did not repaint once per frame").toBeGreaterThanOrEqual(streamOff.frames);
    // #509: the radii are the app's spec, packed once per style: the layout spreading 13% changes none of them.
    expect(streamOff.radiiChanged, "a streamed frame re-sized the physical nodes").toBe(false);
    expect(streamOff.colorCalls, "a streamed frame resolved the module colours again").toBe(0);
    // The state nodes' anchors are copied in place, and the style never re-resolves on a streamed frame.
    expect(streamOff.sameCenters, "a streamed frame reallocated the state nodes' positions").toBe(true);
    expect(streamOff.restyles, `${streamOff.restyles} style re-resolutions over ${streamOff.frames} streamed frames`).toBe(0);
    expect(streamOff.medianMs, `stream frame median ${streamOff.medianMs.toFixed(2)}ms (worst ${streamOff.worstMs.toFixed(2)}ms)`).toBeLessThan(STREAM_FRAME_MS);
  });

  it("container drag on a force layout (#495): the physical layout reheats, the dots follow, at a physical-view drag's cost", () => {
    console.info(
      `[both-perf N=${N}] reheat drag: container ${containerReheat.medianMs.toFixed(2)} ms (worst ${containerReheat.worstMs.toFixed(2)}), ` +
        `physical view ${physicalReheat.medianMs.toFixed(2)} ms (worst ${physicalReheat.worstMs.toFixed(2)}), translate ${dragOff.medianMs.toFixed(2)} ms, dot ${dotDrag.medianMs.toFixed(2)} ms`,
    );
    for (const leg of [containerReheat, physicalReheat]) {
      expect(leg.renders, "a held frame did not render (counted)").toBeGreaterThanOrEqual(leg.moves);
      expect(leg.othersMoved, "no other physical node moved: the drag did not reheat").toBeGreaterThan(N / 2);
      expect(leg.colorCalls, "a drag frame resolved the module colours again").toBe(0);
    }
    expect(containerReheat.dotsFollow, "a dot did not follow its container").toBe(true);
    expect(containerReheat.sameColumns, "a reheat frame rebuilt the container columns without a resize").toBe(true);
    // Baseline (#495): the container drag reheats what the physical view's drag reheats; its frame adds the dots'
    // positions (O(state nodes)) and the both view's larger lane.
    expect(containerReheat.medianMs, `container reheat ${containerReheat.medianMs.toFixed(2)}ms vs physical ${physicalReheat.medianMs.toFixed(2)}ms`).toBeLessThan(
      REHEAT_RATIO * physicalReheat.medianMs + REHEAT_SLACK_MS,
    );
    expect(containerReheat.medianMs).toBeLessThan(REHEAT_MOVE_MS);
  });

  it("state view drag (#495): the plain network's force drag over the state graph, module LOD off and on", () => {
    console.info(
      `[both-perf N=${N}] state drag: off ${stateDrag.off.medianMs.toFixed(2)} ms, lod ${stateDrag.lod.medianMs.toFixed(2)} ms; ` +
        `plain data(state, { modules }): off ${plainDrag.off.medianMs.toFixed(2)} ms, lod ${plainDrag.lod.medianMs.toFixed(2)} ms; ` +
        `one force tick ${dragParts.tickMs.toFixed(2)} ms, the frame without it (translate): off ${dragParts.translateOffMs.toFixed(2)} ms, lod ${dragParts.translateLodMs.toFixed(2)} ms`,
    );
    // Baseline (#495 review): the state view is the plain path, so its drag costs what the plain network's costs.
    for (const [name, leg, base] of [["off", stateDrag.off, plainDrag.off], ["lod", stateDrag.lod, plainDrag.lod]] as const) {
      expect(base.othersMoved, `${name}: the plain baseline did not reheat: the leg is vacuous`).toBeGreaterThan(stateCount / 2);
      expect(leg.medianMs, `${name}: state view ${leg.medianMs.toFixed(2)}ms vs plain ${base.medianMs.toFixed(2)}ms`).toBeLessThan(STATE_PLAIN_RATIO * base.medianMs + STATE_PLAIN_SLACK_MS);
    }
    for (const [name, leg] of [["off", stateDrag.off], ["lod", stateDrag.lod], ["plain off", plainDrag.off], ["plain lod", plainDrag.lod]] as const) {
      expect(leg.renders, `${name}: a held frame did not render (counted)`).toBeGreaterThanOrEqual(leg.moves);
      expect(leg.othersMoved, `${name}: the state layout did not reheat`).toBeGreaterThan(stateCount / 2);
      expect(leg.colorCalls, `${name}: a drag frame resolved the module colours again`).toBe(0);
      expect(leg.medianMs, `${name}: state drag ${leg.medianMs.toFixed(2)}ms (worst ${leg.worstMs.toFixed(2)}ms)`).toBeLessThan(REHEAT_MOVE_MS);
    }
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
