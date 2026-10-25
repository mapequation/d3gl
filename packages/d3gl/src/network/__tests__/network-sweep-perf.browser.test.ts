import { describe, it, expect, beforeAll } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import { perfBudget, perfN, perfRealGpu, softwareRenderer } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames, zoomSteps } from "../../__tests__/engine-sweep.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import type { InstancedLayer } from "../../core/index.js";

/**
 * ENGINE-level at-scale zoom sweep for `network()` (#263, gap 2 of #258).
 *
 * Every at-scale network guard that existed before this one drives a **module**, not the engine:
 * `frontier-perf` calls `computeFrontier` directly, `super-edges-perf` the super-edge builder,
 * `label-candidates-perf` the label ranker. They are the right shape for what they assert, but the
 * thing a user actually triggers — `net.setTransform()` → `BaseEngine.setTransform` → dynamic-lane
 * re-emit → `frontierLayers` → `emitInstancedLane`'s in-place `updateInstancedLayer` — was never
 * driven end-to-end at scale. An O(N)-per-frame cost in the glue between those modules trips nothing.
 *
 * Both reduction states run, per docs/agents/performance.md — a green result on one does not prove the other:
 *   - **LOD OFF** (full detail, the lane is `dynamic: false`): the whole graph is drawn every frame
 *     from a static emit. This is where an O(N)-per-frame cost hides, precisely because nothing is
 *     *supposed* to happen per frame.
 *   - **LOD ON** (reductions on, `dynamic: true`): the lane re-cuts the frontier and re-emits on
 *     every `setTransform`. This is where per-frame work must stay O(visible frontier).
 *
 * Signatures pinned (deterministic first; wall-clock is the order-of-magnitude backstop):
 *   1. **`nodeFill` resolves O(nodes) at registration, ZERO per frame** — in both reduction states,
 *      in the N-invariant `toBe(before)` form. Per-node colour propagates up the LOD tree at build
 *      time, so even a frontier re-cut must not re-invoke it.
 *   2. **`linkStroke` is exactly zero per frame with LOD off, and O(distinct weights) — not
 *      O(drawn super-edges × frames) — with LOD on.** Super-edges are view-dependent (the cut decides
 *      which pairs draw), but a pair's accumulated flow is fixed by the tree and the resolved colour
 *      is memoised per weight, so a sweep that draws tens of thousands of super-edges resolves only
 *      the weights it has not seen before. (Before: the scale ran — and its CSS was re-parsed — once
 *      per drawn super-edge per frame; 52 ms of a 66 ms streamed frame on web-NotreDame.)
 *   3. **GPU buffers are updated in place, not destroyed + recreated, and not re-uploaded** —
 *      `emitInstancedLane`'s `sameSet` fast path plus the bytes actually pushed across the bus, both
 *      counted on the live `WebGL2RenderingContext`, with non-vacuity checks that registration DID
 *      create buffers and DID upload. The upload counter is what gives the full-detail leg teeth:
 *      the accessor assertions there are satisfied for free by the static emit, but re-pushing the
 *      retained instance arrays every frame (the #186 shape) moves no create/delete count at all.
 *   4. **An LOD re-emit that changes nothing uploads only the endpoints** (held view): every style
 *      column (widths, colours, group/selected flags) goes out as the SAME array as the frame before,
 *      so the GPU layers' identity skip drops its upload — the bytes moved equal exactly the columns
 *      that are always written (link endpoints; node centres, radii, colours). Held for each link
 *      primitive the LOD lane emits: lines, whole arrows (directed lines), and half-arrows.
 *   5. **The declutter's cost signature through the real trigger** — `net.declutterStats` after every
 *      `setTransform`: distance tests and grid cells per frontier glyph stay O(1), and the reused grid
 *      scratch stays within ~2 cells per frontier glyph. Asserted on the LOD sweep above and on a dense
 *      leg built to punish the single 2·maxR grid (every leaf in view, 2.5 px leaves packed past
 *      overlap, every 50th node at 20 px): there the single grid spends many times the ceiling.
 *
 * ONE ENGINE, TWO PHASES — deliberate, not tidiness. Constructing a second WebGL engine after a
 * first one has uploaded a ~100k-node graph costs **9-12s in `whenReady()`** on local headless
 * Chromium (measured: 24ms for the first engine, 12,168ms for the second, 9,251ms for a third even
 * when it is tiny, 20ms for a fourth). That stall is not this guard's subject and it would eat the
 * tier's 300s per-file budget, so the LOD-off and LOD-on legs share one engine and toggle `lod()`
 * between them — which also exercises the toggle. Tracked as #287.
 */

// Local default keeps the always-on run ~1s of fixture build; the browser tier raises it via
// PERF_BROWSER_N (#262). `max`: this leg holds the graph, the LOD tree, and the per-frame frontier
// scratch simultaneously, and the LOD tree build is the O(N log N) one-time cost that would eat the
// tier's 300s per-file budget — the same 200k ceiling `gpu-frame-budget-perf` settled on.
const N = perfN(50_000, { max: 200_000 });
const EDGES = N - 1; // the binary-tree fixture below
const COLS = Math.max(1, Math.round(Math.sqrt(N)));
const W = 640;
const H = 400;
// Measured worst frame (best-of-3 per step, local headless Chromium): LOD off 0.10ms at 50k and at
// 100k — Chromium's 100µs `performance.now()` quantum, because a static-emit frame is a uniform
// write plus the instanced draws. LOD on 5.1ms at 50k and 5.6ms at 100k: a real frontier re-cut +
// declutter + in-place re-upload per frame, and near-flat in N, which is the O(visible) property in
// wall-clock form. Separate ceilings because they are different orders of work; each is ~4-6x the
// measured value (non-flaky) and well under an O(N)-per-frame regression (a full 50k-node style
// re-resolve is ~40-90ms/frame).
const FRAME_MS_STATIC = perfBudget(4 + (4 * N) / 50_000);
const FRAME_MS_LOD = perfBudget(20 + (10 * N) / 50_000);
// Per-frame super-edge colour resolutions allowed under LOD. Deliberately an ABSOLUTE number and
// NOT passed through `perfN`/`perfBudget`: it is a deterministic count, and the whole point is that
// it must not grow with N. Measured ~2.3k/frame at both 50k and 100k nodes in this 640x400
// viewport, so ~8x headroom; the regression it catches (colouring every edge per frame) lands at
// `EDGES`, which an assertion below proves sits above this ceiling for whatever N is running.
const LOD_LINK_COLOURS_PER_FRAME = 20_000;
// Per-frame GPU upload allowed under LOD, for the same reason and on the same terms: absolute, so
// it asserts that the frontier's instance upload does not grow with N. Measured ~103 KB/frame at
// 50k and ~105 KB/frame at 100k, so ~10x headroom; the 12MB retained buffer set is what an
// O(N)-per-frame re-upload would push, 12x over the line even at the local default.
const LOD_UPLOAD_BYTES_PER_FRAME = 1024 * 1024;
// Declutter cost per frontier glyph over the LOD sweep (deterministic — never scaled). Probes: the
// radius-class grid measured ~3 on packed leaves, the single 2·maxR grid ~50. Cells: the single grid
// scans ≤ 9 per glyph, a radius-class scan a few per class.
const MAX_DECLUTTER_PROBES_PER_GLYPH = 8;
const MAX_DECLUTTER_CELLS_PER_GLYPH = 16;
// Registration (graph + layout + LOD tree) is the O(N) phase; a timeout is a harness limit, not a
// budget (docs/agents/performance.md).
const SETUP_MS = perfBudget(120_000 + N / 2);

/** A binary-tree graph on a square grid: deterministic positions, a real hierarchy for LOD to coarsen. */
function fixture(n: number): { graph: ReturnType<typeof buildGraph>; positions: Float32Array } {
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = (i % COLS) * 8;
    positions[i * 2 + 1] = Math.floor(i / COLS) * 8;
  }
  const source = new Int32Array(n - 1);
  const target = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) {
    source[i - 1] = i;
    target[i - 1] = Math.floor(i / 2);
  }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), positions };
}

/** One reduction state's measurements: what the sweep re-derived, re-uploaded, and cost. */
/** Every instanced layer the backend was handed, frame by frame (the typed probe for "what was emitted"). */
class LayerSpy {
  frames: InstancedLayer[][] = [];
  private readonly origUpdate = WebGLBackend.prototype.updateInstancedLayer;
  private readonly origSet = WebGLBackend.prototype.setInstancedLayer;
  constructor() {
    const spy = this;
    WebGLBackend.prototype.updateInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
      spy.frames[spy.frames.length - 1]?.push(layer);
      spy.origUpdate.call(this, layer);
    };
    WebGLBackend.prototype.setInstancedLayer = function (this: WebGLBackend, layer: InstancedLayer): void {
      spy.frames[spy.frames.length - 1]?.push(layer);
      spy.origSet.call(this, layer);
    };
  }
  /** Start collecting a new frame's layers. */
  frame(): void {
    this.frames.push([]);
  }
  restore(): void {
    WebGLBackend.prototype.updateInstancedLayer = this.origUpdate;
    WebGLBackend.prototype.setInstancedLayer = this.origSet;
  }
}

/** Instances in a frame's link layers (half-arrows / lines / arrows) — the super-edges drawn. */
function drawnLinks(layers: readonly InstancedLayer[]): number {
  let n = 0;
  for (const l of layers) {
    if (l.primitive === "lines") n += l.lines.count;
    else if (l.primitive === "arrows") n += l.arrows.count;
    else if (l.primitive === "half-arrows") n += l.halfArrows.count;
  }
  return n;
}

/** The aggregate-outline halos a frame emitted, or null when it emitted no `node-halos` layer (#482). */
function haloCount(layers: readonly InstancedLayer[]): number | null {
  for (const l of layers) if (l.primitive === "circles" && l.name === "node-halos") return l.circles.count;
  return null;
}

/** Faint selection rings over a sweep's frames (#538): ring instances whose border is translucent. */
function faintRings(frames: readonly (readonly InstancedLayer[])[]): number {
  let n = 0;
  for (const layers of frames)
    for (const l of layers) {
      if (l.primitive !== "circles" || l.name !== "network-highlight:ring") continue;
      const c = l.circles.borderColors;
      for (let i = 0; c && i < l.circles.count; i++) if ((c[i * 4 + 3] ?? 255) < 255) n++;
    }
  return n;
}

/** Instances in the gathered `links` layer alone: the links that touch an aggregate (#447). */
function gatheredLinks(layers: readonly InstancedLayer[]): number {
  let n = 0;
  for (const l of layers) {
    if (l.primitive === "lines" && l.name === "links") n += l.lines.count;
    else if (l.primitive === "arrows" && l.name === "links") n += l.arrows.count;
    else if (l.primitive === "half-arrows" && l.name === "links") n += l.halfArrows.count;
  }
  return n;
}

/** Bytes of the columns an in-place update ALWAYS writes (positions; a circle's radius/colour/ring). */
function alwaysWrittenBytes(layers: readonly InstancedLayer[]): number {
  let bytes = 0;
  for (const l of layers) {
    if (l.primitive === "circles") {
      const c = l.circles;
      bytes += c.centers.byteLength + c.radii.byteLength + c.colors.byteLength;
      if (c.borders) bytes += c.borders.byteLength + (c.borderColors?.byteLength ?? 0);
    } else if (l.primitive === "lines") bytes += l.lines.sources.byteLength + l.lines.targets.byteLength;
    else if (l.primitive === "arrows") bytes += l.arrows.sources.byteLength + l.arrows.targets.byteLength;
    else if (l.primitive === "half-arrows") bytes += l.halfArrows.sources.byteLength + l.halfArrows.targets.byteLength;
  }
  return bytes;
}

/** The style columns (skippable by reference identity) of a frame's layers, keyed by layer + column. */
function styleColumns(layers: readonly InstancedLayer[]): Map<string, ArrayBufferView> {
  const out = new Map<string, ArrayBufferView>();
  const put = (key: string, v: ArrayBufferView | undefined): void => {
    if (v) out.set(key, v);
  };
  for (const l of layers) {
    if (l.primitive === "lines") {
      put("lines.widths", l.lines.widths);
      put("lines.colors", l.lines.colors);
      put("lines.bends", l.lines.bends);
      put("lines.groups", l.lines.groups);
      put("lines.groups2", l.lines.groups2);
      put("lines.selected", l.lines.selected);
    } else if (l.primitive === "arrows") {
      put("arrows.widths", l.arrows.widths);
      put("arrows.colors", l.arrows.colors);
      put("arrows.bends", l.arrows.bends);
      put("arrows.radii", l.arrows.radii);
      put("arrows.groups", l.arrows.groups);
      put("arrows.groups2", l.arrows.groups2);
      put("arrows.selected", l.arrows.selected);
    } else if (l.primitive === "half-arrows") {
      put("half-arrows.radii", l.halfArrows.radii);
      put("half-arrows.widths", l.halfArrows.widths);
      put("half-arrows.bends", l.halfArrows.bends);
      put("half-arrows.colors", l.halfArrows.colors);
      put("half-arrows.groups", l.halfArrows.groups);
      put("half-arrows.groups2", l.halfArrows.groups2);
      put("half-arrows.selected", l.halfArrows.selected);
    } else if (l.primitive === "circles" && l.name === "nodes") {
      put("nodes.groups", l.circles.groups);
      put("nodes.selected", l.circles.selected);
    }
  }
  return out;
}

interface Leg {
  /** Style-accessor calls counted just before the sweep (i.e. the registration total). */
  nodeFillBefore: number;
  linkStrokeBefore: number;
  /** …and just after it. */
  nodeFillAfter: number;
  linkStrokeAfter: number;
  buffersCreated: number;
  buffersDeleted: number;
  uploadedBytes: number;
  worstFrameMs: number;
  frames: number;
  /** Super-edge instances handed to the backend over the sweep (sum over frames). */
  drawnLinks: number;
  /** `net.declutterStats` summed over the sweep's frames (null frames skipped): glyphs, probes, cells. */
  declutterFrames: number;
  declutterGlyphs: number;
  declutterProbes: number;
  declutterCells: number;
  /** Largest frontier handed to declutter, and the scratch's grid cells, over the sweep. */
  maxDeclutterGlyphs: number;
  maxScratchCells: number;
}

/** A held LOD view re-emitted frame after frame: what moved, and what the emits were made of. */
interface HoldLeg {
  frames: number;
  uploadedBytes: number;
  /** Bytes of the always-written columns over the same frames (the floor an in-place update pays). */
  alwaysWrittenBytes: number;
  /** Style columns that came out as a NEW array although the view (and so the cut) did not change. */
  freshColumns: string[];
  /** Style columns checked (non-vacuity: the held frames really carried links and nodes). */
  checkedColumns: number;
  linkStrokeCalls: number;
  /** Link primitives the held frames emitted (non-vacuity: each leg really drew its link style). */
  primitives: string[];
}

let registrationBuffersCreated = 0;
let registrationUploadedBytes = 0;
let registrationNodeFill = 0;
let registrationLinkStroke = 0;
let buildMs = 0;
let lodBuildMs = 0;
let lodOff: Leg;
let lodOn: Leg;
let lodHold: HoldLeg;
let lodHoldArrows: HoldLeg;
let lodHoldHalfArrows: HoldLeg;
let lodDense: Leg;
let lodSpatial: Leg;
let lodSpatialRepeat: Leg;
let lodSpatialHold: HoldLeg;
let spatialHeldStats: { hits: number; misses: number; visits: number; entries: number; leafRows: number } | null = null;
let spatialSweepStats: { hits: number; misses: number; visits: number } | null = null;
let lodOffSelected: Leg;
/** LOD on with the same selection (#538): the first sweep, then the same sweep again (buffer counts). */
let lodOnSelected: Leg;
let lodOnSelectedRepeat: Leg;
/** Holder markings during the two sweeps (must be 0: marked once, at the select), holders marked, and the
 *  faint rings the sweeps drew (non-vacuity: the cut really drew modules holding a selected node). */
let holderBuildsInSweeps = -1;
let holdersMarked = 0;
let faintRingsDrawn = 0;
/** Pans across a view that gathers no link, per link style; `gathered` is each pan step's gathered-link count. */
const emptyViewLegs: [string, { leg: Leg; gathered: number[] }][] = [];
/** The same pan with the aggregate outline on (#482); `halos` is each pan step's halo count (null: no `node-halos` layer). */
let haloPan: { leg: Leg; halos: (number | null)[] };
/** Per-frame upload allowed per selected node on the full-detail leg: 2x the ring overlay's 24-byte
 *  instance. A deterministic count, so absolute (never through `perfBudget`). */
const RING_BYTES_PER_SELECTED = 48;
/** Nodes selected for the {@link lodOffSelected} leg: every 97th, spread over the whole grid. */
const SELECTED = Array.from({ length: Math.ceil(N / 97) }, (_, i) => i * 97);

beforeAll(async () => {
  const spy = new GlBufferSpy();
  const layerSpy = new LayerSpy();
  try {
    const { graph, positions } = fixture(N);
    let nodeFillCalls = 0;
    let linkStrokeCalls = 0;

    const net = network(perfHost(W, H), { width: W, height: H, backend: "webgl" });
    await net.whenReady();

    const atStart = spy.mark();
    const buildStart = performance.now();
    net
      .data(graph)
      .style({
        nodeRadius: 3,
        sizeMode: "screen",
        nodeFill: (i) => {
          nodeFillCalls++;
          return i % 2 ? "rgb(59,130,246)" : "rgb(245,158,11)";
        },
        linkStroke: (weight) => {
          linkStrokeCalls++;
          return weight > 1 ? "rgb(100,116,139)" : "rgb(203,213,225)";
        },
      })
      .layout({ backend: "positions", positions });
    buildMs = performance.now() - buildStart;
    const registration = spy.since(atStart);
    registrationBuffersCreated = registration.created;
    registrationUploadedBytes = registration.uploadedBytes;
    registrationNodeFill = nodeFillCalls;
    registrationLinkStroke = linkStrokeCalls;

    /** Snapshot the counters, run the sweep, and report the deltas. */
    const runLeg = (steps = zoomSteps(W, H)): Leg => {
      const nodeFillBefore = nodeFillCalls;
      const linkStrokeBefore = linkStrokeCalls;
      const before = spy.mark();
      layerSpy.frames = [];
      let declutterFrames = 0;
      let declutterGlyphs = 0;
      let declutterProbes = 0;
      let declutterCells = 0;
      let maxDeclutterGlyphs = 0;
      let maxScratchCells = 0;
      const { worstFrameMs, frames } = sweepFrames(steps, (t) => {
        layerSpy.frame();
        net.setTransform(t);
        const d = net.declutterStats;
        if (!d) return;
        declutterFrames++;
        declutterGlyphs += d.glyphs;
        declutterProbes += d.probes;
        declutterCells += d.cells;
        maxDeclutterGlyphs = Math.max(maxDeclutterGlyphs, d.glyphs);
        maxScratchCells = Math.max(maxScratchCells, d.scratchCells);
      });
      const buffers = spy.since(before);
      let links = 0;
      for (const f of layerSpy.frames) links += drawnLinks(f);
      return {
        nodeFillBefore,
        linkStrokeBefore,
        nodeFillAfter: nodeFillCalls,
        linkStrokeAfter: linkStrokeCalls,
        buffersCreated: buffers.created,
        buffersDeleted: buffers.deleted,
        uploadedBytes: buffers.uploadedBytes,
        worstFrameMs,
        frames,
        drawnLinks: links,
        declutterFrames,
        declutterGlyphs,
        declutterProbes,
        declutterCells,
        maxDeclutterGlyphs,
        maxScratchCells,
      };
    };

    lodOff = runLeg();

    // Enabling LOD is a REGISTRATION event (it builds the tree and its aggregate geometry), so the
    // accessor counters are re-snapshotted by `runLeg` afterwards — only the per-frame delta is asserted.
    const lodStart = performance.now();
    net.lod({ declutter: true, maxAggregateRadius: 24 });
    lodBuildMs = performance.now() - lodStart;
    lodOn = runLeg();

    // Held view: re-emit the same transform. The cut, the declutter and every style column are
    // unchanged, so only the always-written columns may move across the bus.
    const steps = zoomSteps(W, H);
    const held = steps[Math.floor(steps.length / 2)] ?? { k: 1, x: 0, y: 0 };
    const runHold = (): HoldLeg => {
      net.setTransform(held); // settle: the first emit at this view (or after a restyle) may change columns
      const HOLD = 6;
      const holdStroke = linkStrokeCalls;
      layerSpy.frames = [];
      layerSpy.frame();
      net.setTransform(held); // reference frame
      const holdStart = spy.mark();
      let floor = 0;
      for (let f = 0; f < HOLD; f++) {
        layerSpy.frame();
        net.setTransform(held);
        floor += alwaysWrittenBytes(layerSpy.frames[layerSpy.frames.length - 1] ?? []);
      }
      const holdBytes = spy.since(holdStart).uploadedBytes;
      const fresh: string[] = [];
      const primitives = new Set<string>();
      let checked = 0;
      for (let f = 1; f < layerSpy.frames.length; f++) {
        const prev = styleColumns(layerSpy.frames[f - 1] ?? []);
        for (const l of layerSpy.frames[f] ?? []) if (l.primitive !== "circles") primitives.add(l.primitive);
        for (const [key, col] of styleColumns(layerSpy.frames[f] ?? [])) {
          checked++;
          if (prev.get(key) !== col) fresh.push(`frame ${f} ${key}`);
        }
      }
      return { frames: HOLD, uploadedBytes: holdBytes, alwaysWrittenBytes: floor, freshColumns: fresh, checkedColumns: checked, linkStrokeCalls: linkStrokeCalls - holdStroke, primitives: [...primitives].sort() };
    };
    lodHold = runHold(); // undirected lines
    // The same engine restyled (a second engine would stall whenReady, #287): directed lines draw each link as ONE
    // arrow, its head part of the line lane's strip (#542), and half-arrows replace the lines — the Network
    // Navigator's default link style.
    net.style({ directed: true });
    lodHoldArrows = runHold();
    net.style({ linkStyle: "half-arrow" });
    lodHoldHalfArrows = runHold();

    // Dense mixed-radius frontier, same engine: every leaf in view (expandPx ≈ 0, so LOD cannot shrink
    // the set), zoomed OUT so the 8-unit grid packs 2.5 px leaves 1.2-8 px apart, and every 50th node at
    // 20 px so the single grid's cell is 40 px. Registration again (radii + LOD geometry); only the
    // sweep is counted.
    net.style({ nodeRadius: (_v, i) => (i % 50 === 0 ? 20 : 2.5) });
    net.lod({ declutter: true, maxAggregateRadius: 24, expandPx: 1e-6 });
    lodDense = runLeg(zoomSteps(W, H, [0.15, 0.2, 0.3, 0.45, 0.7, 1]));

    // The spatial source (#343), same engine: a Morton tree built once over the static positions, its
    // links gathered lazily from the graph's edges (no super-edge CSR) with the per-tree row memo.
    net.style({ nodeRadius: 3, directed: false, linkStyle: "line" });
    net.lod({ source: "spatial", declutter: true, maxAggregateRadius: 24 });
    lodSpatial = runLeg();
    spatialSweepStats = net.superEdgeStats;
    // The same sweep again, for the GPU buffer counts alone. The lod() call sizes the link layers for the view it
    // starts at, and the first sweep may outgrow them once (a lane grows to at least 2× its capacity): at
    // PERF_BROWSER_N, declutterSpacing 2 draws 806 gathered lines at k=1 and 1,875 at k=2. A layer that is destroyed
    // and rebuilt on every pass (#469) still shows here; a one-time grow does not.
    lodSpatialRepeat = runLeg();
    net.setTransform(held);
    net.setTransform(held); // an unchanged re-emit: every aggregate's row from the memo
    spatialHeldStats = net.superEdgeStats;
    lodSpatialHold = runHold();
    // A view that gathers no link, same engine: pan off the graph and back. The gathered link layers hold only the
    // links that touch an aggregate (#447), so they empty there, and must keep their GPU buffers through it rather
    // than be dropped and rebuilt on the next frame that gathers one. Directed lines draw whole arrows (one
    // layer, #542), half-arrows the third primitive; each restyle is a registration event, settled before the leg.
    const away = { ...held, x: held.x - 100 * W };
    const pan = [held, away, held, away, held];
    for (const [name, restyle] of [
      ["directed lines", { directed: true }],
      ["half-arrows", { linkStyle: "half-arrow" }],
    ] as const) {
      net.style(restyle);
      net.setTransform(held);
      const leg = runLeg(pan);
      const reps = layerSpy.frames.length / pan.length; // sweepFrames repeats each step
      emptyViewLegs.push([name, { leg, gathered: pan.map((_, s) => gatheredLinks(layerSpy.frames[s * reps] ?? [])) }]);
    }
    net.style({ directed: false, linkStyle: "line" });
    // A view with no aggregate (#482): the aggregate-outline halo layer empties there and must keep its GPU buffers
    // the same way. The pan starts zoomed out (k = 0.1: the whole 8-unit grid in view at 0.8 px a cell), where the
    // cut draws aggregates; at the sweep's k ≥ 1 every glyph in view is a leaf, which carries no halo.
    net.lod({ declutter: true, maxAggregateRadius: 24, aggregateOutline: {} });
    const wide = zoomSteps(W, H, [0.1])[0] ?? held;
    const wideAway = { ...wide, x: wide.x - 100 * W };
    const widePan = [wide, wideAway, wide, wideAway, wide];
    net.setTransform(wide);
    const haloLeg = runLeg(widePan);
    const haloReps = layerSpy.frames.length / widePan.length;
    haloPan = { leg: haloLeg, halos: widePan.map((_, s) => haloCount(layerSpy.frames[s * haloReps] ?? [])) };
    // LOD on with a managed selection (#538): every 97th node selected, most of them collapsed into the modules the
    // cut draws, which ring faintly and stay undimmed. The holders are marked once at the select() (a registration
    // event, outside the sweep); a zoom frame reads one flag per frontier glyph. Twice, as the spatial legs: the
    // first sweep may grow the ring layer once (its count follows the frontier), a layer rebuilt per frame shows
    // on the second.
    // The sweep runs zoomed out (k 0.1 to 1), where the cut draws modules: from k = 1 in, it draws leaves.
    const outSteps = zoomSteps(W, H, [0.1, 0.15, 0.2, 0.3, 0.45, 0.7, 1]);
    net.lod({ declutter: true, maxAggregateRadius: 24 }).interactive({ selectable: true }).select("nodes", SELECTED);
    const holderBuilds = net.holderStats.builds;
    lodOnSelected = runLeg(outSteps);
    faintRingsDrawn = faintRings(layerSpy.frames);
    lodOnSelectedRepeat = runLeg(outSteps);
    holderBuildsInSweeps = net.holderStats.builds - holderBuilds;
    holdersMarked = net.holderStats.holders;
    // Full detail again, with a managed selection (#428): the no-LOD selected-flag cache is keyed on the
    // selection set, so a key that stopped matching per frame would rebuild and re-upload the flags on
    // every zoom step. The toggle and the select() are registration events, outside the sweep.
    net.lod(false).interactive({ selectable: true }).select("nodes", SELECTED);
    lodOffSelected = runLeg();

    net.destroy();
  } finally {
    layerSpy.restore();
    spy.restore();
  }
}, SETUP_MS);

describe(`network() engine zoom sweep — per-frame cost at N=${N.toLocaleString()} nodes / ${EDGES.toLocaleString()} edges (#263)`, () => {
  it("registers the style ONCE per node and really owns GPU buffers (non-vacuity)", () => {
    // Without this the zeros below could mean "the fixture never built" instead of "nothing re-ran".
    expect(registrationNodeFill, "nodeFill never ran — the fixture did not register").toBe(N);
    expect(registrationLinkStroke, "linkStroke never ran — the link pass did not build").toBeGreaterThan(0);
    expect(
      registrationBuffersCreated,
      "registration created no GPU buffer — the spy is not observing the live context",
    ).toBeGreaterThan(0);
    expect(
      registrationUploadedBytes,
      "registration uploaded no geometry — the spy is not observing the live context",
    ).toBeGreaterThan(0);
    // The per-frame ceiling only means something while it sits below a full pass over the edges.
    expect(
      LOD_LINK_COLOURS_PER_FRAME,
      "the fixture is too small for the per-frame link-colour ceiling to bite — raise N or lower the ceiling",
    ).toBeLessThan(EDGES);
  });

  it("LOD OFF (full detail): the static emit re-derives nothing and re-uploads nothing per frame", () => {
    expect(lodOff.nodeFillAfter, "nodeFill re-ran during the full-detail zoom sweep").toBe(lodOff.nodeFillBefore);
    // `dynamic: false` ⇒ the emit is static ⇒ link-colour work per frame is exactly zero.
    expect(lodOff.linkStrokeAfter, "linkStroke re-ran during the zoom sweep on a static emit").toBe(lodOff.linkStrokeBefore);
    expect(lodOff.buffersCreated, "GPU buffers were created during the full-detail zoom sweep").toBe(0);
    expect(lodOff.buffersDeleted, "GPU buffers were destroyed during the full-detail zoom sweep").toBe(0);
    // …and nothing is re-uploaded into them. Measured: exactly 0 bytes over the sweep against 12MB
    // at registration. This is the assertion with teeth on the full-detail leg — the accessor counts
    // above are satisfied for free by the static emit, whereas a re-upload of the retained node/link
    // instance arrays (the #186 shape) lands at ~1x the registration figure, 1000x over this line.
    // The ratio form (rather than `toBe(0)`) keeps a future per-frame UNIFORM write from tripping it.
    expect(
      lodOff.uploadedBytes,
      `${lodOff.uploadedBytes.toLocaleString()} bytes re-uploaded over the full-detail sweep (registration uploaded ${registrationUploadedBytes.toLocaleString()})`,
    ).toBeLessThan(registrationUploadedBytes / 1000);
    expect(
      lodOff.worstFrameMs,
      `LOD off: worst frame ${lodOff.worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()} (build ${buildMs.toFixed(0)}ms once)`,
    ).toBeLessThan(FRAME_MS_STATIC);
  });

  it("LOD ON (reductions on): the frontier re-cut stays O(visible) and re-uploads in place", () => {
    // Signature 1 — per-node colour stays a build-time cost even though the frontier re-cuts per frame.
    expect(lodOn.nodeFillAfter, "nodeFill re-ran during the LOD zoom sweep").toBe(lodOn.nodeFillBefore);

    // Signature 2 — super-edges are view-dependent (the cut decides which pairs draw), but a pair's
    // colour is a function of its accumulated flow, memoised per weight for the style: the sweep draws
    // tens of thousands of super-edges and resolves only the weights it has not met yet. The ceiling
    // stays absolute and N-independent (O(visible), not O(N)); the ratio pins the memo — before it the
    // scale ran once per DRAWN super-edge per frame, i.e. sweepLinkStroke === drawnLinks.
    const sweepLinkStroke = lodOn.linkStrokeAfter - lodOn.linkStrokeBefore;
    const perFrame = sweepLinkStroke / lodOn.frames;
    expect(lodOn.drawnLinks, "the LOD sweep drew no super-edge — the frontier never re-cut").toBeGreaterThan(1000);
    expect(
      perFrame,
      `LOD sweep resolved ${perFrame.toFixed(0)} link colours per frame (${sweepLinkStroke.toLocaleString()} over ${lodOn.frames} frames) — must stay screen-bounded, not O(${EDGES.toLocaleString()} edges)`,
    ).toBeLessThan(LOD_LINK_COLOURS_PER_FRAME);
    expect(
      sweepLinkStroke,
      `${sweepLinkStroke.toLocaleString()} link-colour resolutions for ${lodOn.drawnLinks.toLocaleString()} drawn super-edges — resolved per drawn edge per frame, not per distinct weight`,
    ).toBeLessThan(lodOn.drawnLinks / 100);

    // Signature 3 — a set-stable re-emit takes the in-place path, so no per-frame buffer churn.
    expect(lodOn.buffersCreated, "GPU buffers were created during the LOD zoom sweep").toBe(0);
    expect(lodOn.buffersDeleted, "GPU buffers were destroyed during the LOD zoom sweep").toBe(0);
    // The frontier genuinely changes per frame, so bytes DO move here — the requirement is that the
    // volume is screen-bounded, not O(N). Measured ~103 KB/frame at 50k nodes and ~105 KB/frame at
    // 100k (flat, as the declutter-bounded frontier demands), against a 12MB retained upload. Like
    // the link-colour ceiling above this is an ABSOLUTE, N-independent number.
    const uploadPerFrame = lodOn.uploadedBytes / lodOn.frames;
    expect(uploadPerFrame, "the LOD sweep uploaded nothing — the frontier never re-cut").toBeGreaterThan(0);
    expect(
      uploadPerFrame,
      `LOD sweep uploaded ${(uploadPerFrame / 1024).toFixed(0)} KB per frame (${lodOn.uploadedBytes.toLocaleString()} bytes over ${lodOn.frames} frames) — must stay screen-bounded, not O(N)`,
    ).toBeLessThan(LOD_UPLOAD_BYTES_PER_FRAME);
    expect(
      lodOn.worstFrameMs,
      `LOD on: worst frame ${lodOn.worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()} (LOD tree ${lodBuildMs.toFixed(0)}ms once)`,
    ).toBeLessThan(FRAME_MS_LOD);

    // Signature 5 — the declutter's cost through the real trigger (see expectDeclutterBounded).
    expectDeclutterBounded("LOD sweep", lodOn);
  });

  it("LOD ON, dense mixed-radius frontier: the declutter stays O(1) per glyph through setTransform", () => {
    // Non-vacuity: the cut really handed over every leaf in view — a large, packed frontier.
    expect(lodDense.maxDeclutterGlyphs, "the dense leg's frontier never grew past the LOD sweep's").toBeGreaterThan(4 * lodOn.maxDeclutterGlyphs);
    expect(lodDense.nodeFillAfter, "nodeFill re-ran during the dense sweep").toBe(lodDense.nodeFillBefore);
    // Measured at 50k (frontier up to 43.5k glyphs): 2.5 probes and 5.1 cells per glyph; with every
    // candidate forced onto the single 2·maxR grid, 101 probes per glyph — 12x over the ceiling.
    expectDeclutterBounded("dense sweep", lodDense);
  });

  /** The declutter's deterministic cost signature over a sweep: every frame ran a pass, probes and grid
   *  cells per frontier glyph stay O(1), and the reused scratch stays within ~2 cells per glyph. */
  const expectDeclutterBounded = (name: string, leg: Leg): void => {
    expect(leg.declutterFrames, `${name}: declutterStats was null — no declutter pass ran`).toBe(leg.frames);
    expect(leg.declutterGlyphs, `${name}: the declutter was handed no frontier glyphs`).toBeGreaterThan(0);
    const probesPerGlyph = leg.declutterProbes / leg.declutterGlyphs;
    const cellsPerGlyph = leg.declutterCells / leg.declutterGlyphs;
    expect(probesPerGlyph, `${name}: ${probesPerGlyph.toFixed(2)} declutter probes per frontier glyph`).toBeLessThan(MAX_DECLUTTER_PROBES_PER_GLYPH);
    expect(cellsPerGlyph, `${name}: ${cellsPerGlyph.toFixed(2)} declutter grid cells per frontier glyph`).toBeLessThan(MAX_DECLUTTER_CELLS_PER_GLYPH);
    // The scratch holds the single grid plus the radius classes: the finest class has ≤ ~1 cell per
    // frontier glyph (floored at 4096), the coarser ones a third more, plus a border ring per class.
    const scratchCeiling = 2 * Math.max(leg.maxDeclutterGlyphs, 4096) + 16 * (W + H);
    expect(leg.maxScratchCells, `${name}: declutter scratch ${leg.maxScratchCells.toLocaleString()} cells for a ${leg.maxDeclutterGlyphs.toLocaleString()}-glyph frontier`).toBeLessThanOrEqual(scratchCeiling);
  };

  const holdLegs = (): [string, HoldLeg, string[]][] => [
    ["lines", lodHold, ["lines"]],
    ["directed lines (whole arrows, #542)", lodHoldArrows, ["arrows"]],
    ["half-arrows", lodHoldHalfArrows, ["half-arrows"]],
  ];

  it("LOD ON, spatial source (#343): lazy links from the row memo, O(visible) re-cut, in-place re-upload", () => {
    // Non-vacuity: the spatial tree drew links, and gathered them lazily — so no super-edge CSR exists.
    expect(spatialSweepStats, "the spatial leg never ran the lazy super-edge gather").not.toBeNull();
    expect(lodSpatial.drawnLinks, "the spatial sweep drew no link").toBeGreaterThan(1000);
    expect(lodSpatial.nodeFillAfter, "nodeFill re-ran during the spatial sweep").toBe(lodSpatial.nodeFillBefore);
    const perFrame = (lodSpatial.linkStrokeAfter - lodSpatial.linkStrokeBefore) / lodSpatial.frames;
    expect(perFrame, `spatial sweep resolved ${perFrame.toFixed(0)} link colours per frame`).toBeLessThan(LOD_LINK_COLOURS_PER_FRAME);
    expect(lodSpatialRepeat.buffersCreated, "GPU buffers were created during the repeated spatial sweep").toBe(0);
    expect(lodSpatialRepeat.buffersDeleted, "GPU buffers were destroyed during the repeated spatial sweep").toBe(0);
    const uploadPerFrame = lodSpatial.uploadedBytes / lodSpatial.frames;
    expect(uploadPerFrame, `spatial sweep uploaded ${(uploadPerFrame / 1024).toFixed(0)} KB per frame`).toBeLessThan(LOD_UPLOAD_BYTES_PER_FRAME);
    expect(lodSpatial.worstFrameMs, `spatial: worst frame ${lodSpatial.worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS_LOD);
    expectDeclutterBounded("spatial sweep", lodSpatial);
    // Deterministic: a held view walks no edge and rebuilds no row. Every kept glyph's links come from the memo, a
    // kept leaf's too (#463: its row records the neighbours that were kept leaves, whose links are drawn as graph
    // edges, #447), so no kept leaf's row is rebuilt either.
    expect(spatialHeldStats?.misses, "held view: rows rebuilt").toBe(0);
    expect(spatialHeldStats?.visits, "held view: edge incidences walked").toBe(0);
    expect(spatialHeldStats?.leafRows, "held view: kept-leaf rows rebuilt").toBe(0);
    expect((spatialHeldStats?.hits ?? 0) + (spatialHeldStats?.entries ?? 0), "held view: rows from the memo or the leaves' edges").toBeGreaterThan(0);
    // …and the held frames hand back the same style columns and upload only the endpoints.
    expect(lodSpatialHold.freshColumns, "spatial: style columns re-emitted as new arrays on an unchanged view").toEqual([]);
    expect(lodSpatialHold.uploadedBytes).toBeLessThanOrEqual(lodSpatialHold.alwaysWrittenBytes);
    expect(lodSpatialHold.linkStrokeCalls, "spatial: link colours re-resolved on an unchanged view").toBe(0);
  });

  it("LOD ON, a view with no aggregate: the halo layer is emitted empty and keeps its GPU buffers (#482)", () => {
    // Non-vacuity: the wide view draws halos; the view off the graph draws none and still emits the layer.
    expect(haloPan.halos[0] ?? 0, "the wide view drew no halo").toBeGreaterThan(0);
    expect(haloPan.halos[1], "the view off the graph dropped the halo layer or drew halos").toBe(0);
    expect(haloPan.leg.buffersCreated, "GPU buffers were created panning across a view with no aggregate").toBe(0);
    expect(haloPan.leg.buffersDeleted, "GPU buffers were destroyed panning across a view with no aggregate").toBe(0);
  });

  it("LOD ON, a view that gathers no link: the gathered link layers keep their GPU buffers", () => {
    expect(emptyViewLegs.map(([name]) => name)).toEqual(["directed lines", "half-arrows"]);
    for (const [name, { leg, gathered }] of emptyViewLegs) {
      // Non-vacuity: the held view gathers links, the view off the graph gathers none.
      expect(gathered[0], `${name}: the held view gathered no link`).toBeGreaterThan(0);
      expect(gathered[1], `${name}: the view off the graph gathered links`).toBe(0);
      expect(leg.buffersCreated, `${name}: GPU buffers were created panning across a view that gathers no link`).toBe(0);
      expect(leg.buffersDeleted, `${name}: GPU buffers were destroyed panning across a view that gathers no link`).toBe(0);
    }
  });

  it("LOD ON, held view: an unchanged re-emit hands back the same style columns and uploads only the endpoints", () => {
    for (const [name, leg, primitives] of holdLegs()) {
      // Non-vacuity: the held frames drew this link style, so there were columns to keep stable.
      expect(leg.primitives, `${name}: the link primitives the held frames emitted`).toEqual(primitives);
      expect(leg.checkedColumns, `${name}: the held frames emitted no style columns`).toBeGreaterThanOrEqual(leg.frames * 5);
      expect(leg.alwaysWrittenBytes, `${name}: the held frames drew nothing`).toBeGreaterThan(0);
      // Signature 4 (deterministic): the SAME array objects, frame after frame — so the identity skip fires.
      expect(leg.freshColumns, `${name}: style columns re-emitted as new arrays on an unchanged view`).toEqual([]);
      // …and the bus sees only the always-written columns. Before: every width/colour/group/selected
      // column re-uploaded too — measured 59 KB against a 30 KB floor over the 6 held frames at 50k (lines).
      expect(
        leg.uploadedBytes,
        `${name}: held view uploaded ${leg.uploadedBytes.toLocaleString()} bytes over ${leg.frames} frames; the always-written columns are ${leg.alwaysWrittenBytes.toLocaleString()}`,
      ).toBeLessThanOrEqual(leg.alwaysWrittenBytes);
      // A held view resolves no link colour at all (every weight is already memoised).
      expect(leg.linkStrokeCalls, `${name}: link colours re-resolved on an unchanged view`).toBe(0);
    }
  });

  it("LOD ON with a selection: holders are marked once, not per frame, and the re-cut stays O(visible) (#538)", () => {
    // Non-vacuity: the selection really sat collapsed in modules the sweep drew.
    expect(holdersMarked, "the selection marked no holder — nothing selected sits under a module").toBeGreaterThan(0);
    expect(faintRingsDrawn, "the sweep drew no faint ring — no module holding a selected node was on the frontier").toBeGreaterThan(0);
    // The signature: the holders are marked at the select(), never by a zoom frame.
    expect(holderBuildsInSweeps, "a zoom frame re-marked the holders").toBe(0);
    for (const [name, leg] of [["first sweep", lodOnSelected], ["second sweep", lodOnSelectedRepeat]] as const) {
      expect(leg.nodeFillAfter, `${name}: nodeFill re-ran during the selected LOD sweep`).toBe(leg.nodeFillBefore);
      const perFrame = leg.uploadedBytes / leg.frames;
      expect(perFrame, `${name}: ${(perFrame / 1024).toFixed(0)} KB uploaded per frame — must stay screen-bounded, not O(N)`).toBeLessThan(LOD_UPLOAD_BYTES_PER_FRAME);
      expect(leg.worstFrameMs, `${name}: LOD on, ${SELECTED.length.toLocaleString()} nodes selected: worst frame ${leg.worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS_LOD);
    }
    expect(lodOnSelectedRepeat.buffersCreated, "GPU buffers were created during the second selected LOD sweep").toBe(0);
    expect(lodOnSelectedRepeat.buffersDeleted, "GPU buffers were destroyed during the second selected LOD sweep").toBe(0);
  });

  it("LOD OFF with a selection: a zoom frame uploads O(selected), not the selected flags (#428)", () => {
    expect(lodOffSelected.nodeFillAfter, "nodeFill re-ran during the selected full-detail sweep").toBe(lodOffSelected.nodeFillBefore);
    expect(lodOffSelected.linkStrokeAfter, "linkStroke re-ran during the selected full-detail sweep").toBe(lodOffSelected.linkStrokeBefore);
    expect(lodOffSelected.buffersCreated, "GPU buffers were created during the selected full-detail sweep").toBe(0);
    expect(lodOffSelected.buffersDeleted, "GPU buffers were destroyed during the selected full-detail sweep").toBe(0);
    // What a selection adds per frame is the ring overlay's instances: 24 bytes per selected node (measured
    // exactly 516 × 24 B per frame at 50k), O(selected) and absolute. Rebuilding the lane's selected flags
    // would re-upload one byte per node and per edge on top — the line below only holds while that sits
    // above it. (The flags cache is not even read per zoom frame: the full-detail emit is static.)
    const perFrame = lodOffSelected.uploadedBytes / lodOffSelected.frames;
    const ringBound = SELECTED.length * RING_BYTES_PER_SELECTED;
    expect(N + EDGES, "the fixture is too small for a flags re-upload to cross the ring bound").toBeGreaterThan(ringBound);
    expect(
      perFrame,
      `${perFrame.toLocaleString()} bytes uploaded per frame with ${SELECTED.length.toLocaleString()} nodes selected — must stay O(selected), not O(${(N + EDGES).toLocaleString()} nodes + edges)`,
    ).toBeLessThan(ringBound);
    expect(
      lodOffSelected.worstFrameMs,
      `LOD off, ${SELECTED.length.toLocaleString()} nodes selected: worst frame ${lodOffSelected.worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()}`,
    ).toBeLessThan(FRAME_MS_STATIC);
  });
});

// ---- directed-link GPU draw cost (#542, PR #552 audit S1) ----------------------------------------------------
//
// Hardware GPU only: run it by hand with
//   PERF_REAL_GPU=1 pnpm --filter @mapequation/d3gl test:browser src/network/__tests__/network-sweep-perf.browser.test.ts -t "directed-link lane"
// CI and the default tiers leave `PERF_REAL_GPU` unset, so the case is skipped there: SwiftShader has no
// usable GPU timer, and a 1M-link draw under software GL would take the tier's whole file budget. The `-t`
// filter skips the file's beforeAll legs above (a vitest suite whose tests are all filtered out runs no hooks); the
// case builds its own engine, so an unfiltered real-GPU run of the file also pays the second-engine stall (#287).
//
// A directed link draws as ONE instanced draw (shaft + head, 51 vertices per instance) where an undirected link
// draws 48. The guard times each link-lane draw on the GPU (EXT_disjoint_timer_query_webgl2), LOD off at 1M links,
// and asserts directed / undirected per lane. A ratio of GPU timer results on the same viewport, width and view is
// robust to CPU load; frame wall time is not.
const ARROW_LINKS = 1_000_000;
const ARROW_COLS = 1000;
const ARROW_W = 1600;
const ARROW_H = 1200;
const ARROW_FRAMES = 60;
const ARROW_WARMUP = 15;
// Directed / undirected lane GPU ms per frame, measured on an Apple M1 Max (ANGLE Metal, headless), 1600×1200, LOD
// off, fit view, three runs at load average 17-20: width 1 1.12-1.15×, width 4 1.21× (≈77 vs 68 ms and ≈87 vs 72 ms);
// a 100-frame headed run measured 1.09× and 1.25×. The ceiling is 1.2× over the worst of those (1.25), and a second
// full-lane draw (≈2×) trips it. A ratio of GPU times is not machine speed, so it never goes through `perfBudget`.
const ARROW_GPU_RATIO_MAX = 1.5;
const TIME_ELAPSED_EXT = 0x88bf; // EXT_disjoint_timer_query_webgl2 (untyped in lib.dom)
const GPU_DISJOINT_EXT = 0x8fbb;

type LinkLane = "arrows" | "lines";
type DrawArraysInstanced = WebGL2RenderingContext["drawArraysInstanced"];
type DrawElementsInstanced = WebGL2RenderingContext["drawElementsInstanced"];

/** Wraps every instanced draw of a link lane in a GPU timer query, per frame; the lane is told by its program. */
class LinkDrawTimer {
  frame = -1;
  private readonly recs: { gl: WebGL2RenderingContext; q: WebGLQuery; lane: LinkLane; frame: number; instances: number }[] = [];
  private readonly lanes = new Map<WebGLProgram, LinkLane | null>();
  private readonly origArrays: DrawArraysInstanced;
  private readonly origElements: DrawElementsInstanced;

  constructor() {
    const proto = WebGL2RenderingContext.prototype;
    this.origArrays = proto.drawArraysInstanced;
    this.origElements = proto.drawElementsInstanced;
    const timer = this;
    proto.drawArraysInstanced = function (this: WebGL2RenderingContext, mode, first, count, instances) {
      timer.timed(this, instances, () => timer.origArrays.call(this, mode, first, count, instances));
    };
    proto.drawElementsInstanced = function (this: WebGL2RenderingContext, mode, count, type, offset, instances) {
      timer.timed(this, instances, () => timer.origElements.call(this, mode, count, type, offset, instances));
    };
  }

  restore(): void {
    WebGL2RenderingContext.prototype.drawArraysInstanced = this.origArrays;
    WebGL2RenderingContext.prototype.drawElementsInstanced = this.origElements;
  }

  private laneOf(gl: WebGL2RenderingContext): LinkLane | null {
    const program: unknown = gl.getParameter(gl.CURRENT_PROGRAM);
    if (!(program instanceof WebGLProgram)) return null;
    const known = this.lanes.get(program);
    if (known !== undefined) return known;
    const vs = (gl.getAttachedShaders(program) ?? []).map((s) => gl.getShaderSource(s) ?? "").find((s) => s.includes("gl_Position")) ?? "";
    // The head-line program (directed lines, #542) declares `u_arrowSize`; the plain line program bends by `a_bend`.
    const lane: LinkLane | null = vs.includes("u_arrowSize") ? "arrows" : vs.includes("a_bend") && !vs.includes("u_loop") ? "lines" : null;
    this.lanes.set(program, lane);
    return lane;
  }

  private timed(gl: WebGL2RenderingContext, instances: number, draw: () => void): void {
    const lane = this.frame < 0 ? null : this.laneOf(gl);
    const q = lane ? gl.createQuery() : null;
    if (!lane || !q) return draw();
    gl.beginQuery(TIME_ELAPSED_EXT, q);
    draw();
    gl.endQuery(TIME_ELAPSED_EXT);
    this.recs.push({ gl, q, lane, frame: this.frame, instances });
  }

  /** Waits for every query; the median per-frame GPU ms of one lane, and the most instances one draw drew. */
  async collect(lane: LinkLane): Promise<{ medianMs: number; frames: number; instances: number; disjoint: boolean }> {
    const last = this.recs[this.recs.length - 1];
    for (let tries = 0; last && tries < 4000 && !last.gl.getQueryParameter(last.q, last.gl.QUERY_RESULT_AVAILABLE); tries++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const disjoint = last ? Boolean(last.gl.getParameter(GPU_DISJOINT_EXT)) : false;
    const perFrame = new Map<number, number>();
    let instances = 0;
    for (const r of this.recs) {
      const ns = Number(r.gl.getQueryParameter(r.q, r.gl.QUERY_RESULT));
      r.gl.deleteQuery(r.q);
      if (r.lane !== lane) continue;
      perFrame.set(r.frame, (perFrame.get(r.frame) ?? 0) + ns / 1e6);
      instances = Math.max(instances, r.instances);
    }
    this.recs.length = 0;
    const ms = [...perFrame.values()].sort((a, b) => a - b);
    return { medianMs: ms[Math.floor(ms.length / 2)] ?? Number.NaN, frames: ms.length, instances, disjoint };
  }
}

/** ARROW_LINKS links on a grid, each to its left (or upper) neighbour: every link is 8 units long. */
function arrowFixture(): { graph: ReturnType<typeof buildGraph>; positions: Float32Array } {
  const n = ARROW_LINKS + 1;
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = (i % ARROW_COLS) * 8;
    positions[i * 2 + 1] = Math.floor(i / ARROW_COLS) * 8;
  }
  const source = new Int32Array(ARROW_LINKS);
  const target = new Int32Array(ARROW_LINKS);
  for (let i = 1; i < n; i++) {
    source[i - 1] = i;
    target[i - 1] = i % ARROW_COLS ? i - 1 : i - ARROW_COLS;
  }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: true }), positions };
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

describe("directed-link lane GPU cost, LOD off at 1M links (#542, hardware GPU only)", () => {
  it.skipIf(!perfRealGpu)(
    "the directed-link lane's GPU time stays within a budget of the undirected lane's",
    async () => {
      expect(softwareRenderer(), "PERF_REAL_GPU is set, but WebGL renders in software").toBe(false);
      const timer = new LinkDrawTimer();
      const host = perfHost(ARROW_W, ARROW_H);
      const net = network(host, { width: ARROW_W, height: ARROW_H, backend: "webgl" });
      try {
        await net.whenReady();
        const { graph, positions } = arrowFixture();
        net.data(graph).layout({ backend: "positions", positions });
        const k = (Math.min(ARROW_W, ARROW_H) / (ARROW_COLS * 8)) * 0.95;
        const fit = { k, x: ARROW_W / 2 - 4000 * k, y: ARROW_H / 2 - 4000 * k };
        for (const linkWidth of [1, 4]) {
          const ms: Record<LinkLane, number> = { arrows: Number.NaN, lines: Number.NaN };
          for (const [lane, directed] of [["arrows", true], ["lines", false]] as const) {
            net.style({ directed, linkStyle: "line", linkBend: 0.25, sizeMode: "screen", nodeRadius: 2, nodeFill: "#1f77b4", linkWidth, arrowSize: 4, linkStroke: "#555" });
            // A sub-pixel jitter makes every frame a real redraw without changing what is drawn.
            for (let f = 0; f < ARROW_WARMUP; f++) {
              net.setTransform({ ...fit, x: fit.x + (f % 2) * 0.01 });
              await nextFrame();
            }
            for (let f = 0; f < ARROW_FRAMES; f++) {
              timer.frame = f;
              net.setTransform({ ...fit, x: fit.x + (f % 2) * 0.01 });
              await nextFrame();
            }
            timer.frame = -1;
            const r = await timer.collect(lane);
            expect(r.disjoint, "the GPU timer reported a disjoint event; re-run on an idle machine").toBe(false);
            expect(r.frames, `${lane}: no timed frame drew the lane`).toBeGreaterThan(ARROW_FRAMES / 2);
            expect(r.instances, `${lane}: LOD off must draw every link in one lane`).toBe(ARROW_LINKS);
            ms[lane] = r.medianMs;
          }
          const ratio = ms.arrows / ms.lines;
          console.log(`ARROW_GPU w${linkWidth}: directed ${ms.arrows.toFixed(1)} ms vs undirected ${ms.lines.toFixed(1)} ms = ${ratio.toFixed(3)}x`);
          expect(ratio, `width ${linkWidth}: directed ${ms.arrows.toFixed(1)} ms vs undirected ${ms.lines.toFixed(1)} ms GPU per frame`).toBeLessThan(ARROW_GPU_RATIO_MAX);
        }
      } finally {
        timer.restore();
        net.destroy();
        host.remove();
      }
    },
    300_000,
  );
});
