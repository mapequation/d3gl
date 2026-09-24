import { describe, it, expect, beforeAll } from "vitest";
import { network } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import type { ModulePathNode } from "../module-colors.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import type { InstancedLayer, InstancedHighlight } from "../../core/backend.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames, zoomSteps, type GlBufferUsage } from "../../__tests__/engine-sweep.js";

/**
 * Per-interaction guard for the state-network **physical-view pie** highlight (#175).
 *
 * The pie joined the #162 shader highlight: a hover pushes `u_hoverGroup` / the dim uniforms to it, a
 * selection change rewrites its per-wedge `selected` column in place, and every lane emit carries the
 * cached flags so a layout/drag frame cannot zero them. That puts pie work on four §5 paths — hover-move,
 * selection change, the zoom sweep, and the node-drag re-emit — and this guard drives each one through
 * its REAL trigger (pointer events, `select()`, `setTransform`) on one engine at `PERF_BROWSER_N`.
 *
 * Deterministic signatures (asserted at every N; wall-clock is the order-of-magnitude backstop):
 *   - **hover**: zero base-lane (re-)emits, a constant number of uniform pushes per hover change (never
 *     O(wedges)), no `selected` rewrite, no buffer churn, and an N-independent upload per move (the ring
 *     overlay's one circle) — a pie re-upload would be ~1 MB at the local default.
 *   - **selection change**: zero base-lane emits; the bytes uploaded are exactly the flag columns the
 *     uniform pushes carry (nodes + links + the pie's one flag per wedge) plus the ring — no geometry.
 *   - **zoom sweep** (selection active): the static no-LOD lane never re-emits (so `physicalPieInstances`
 *     and its per-wedge colour parse never run), accessors stay flat, no buffer churn, and the upload
 *     per frame is the ring overlay's alone.
 *   - **node-drag**: every move re-emits the pie (pre-existing, filed as a follow-up) but hands it the
 *     SAME cached `selected` array the selection built — no O(wedges) flag rebuild per move, and the
 *     renderer's reference check skips the flag upload.
 *   - **LOD on**: the frontier emits no pie (pies are not LOD-aware yet, #174). The leg pins that the
 *     no-LOD pie is REMOVED when LOD switches on — it used to linger on the backend, stale — and that no
 *     pie work runs per hover or per zoom frame there. When #174 lands, this leg is where the frontier
 *     pie's own O(visible) signature goes.
 *
 * ONE ENGINE for every leg, LOD toggled last — never a second WebGL engine after a large one (#287).
 */

// Physical nodes. 4 in 5 span two modules (a 2-wedge pie), every 5th is a single-module disc, so the
// pie lane carries ~1.6 N wedges. `max`: buildStateGraph + physicalPieWedges + the LOD tree build are the
// O(N)-to-O(N log N) setup costs; 100k physical nodes (160k wedges, 200k links) stays well inside the
// tier's per-file budget, as the network sweep guard's 200k ceiling does for a lighter fixture.
const N = perfN(20_000, { max: 100_000 });
const COLS = Math.max(1, Math.round(Math.sqrt(N)));
const SPACING = 8;
const W = 640;
const H = 400;
/** Hover targets: consecutive nodes along one grid row inside the viewport (8px pitch > 6px glyph, so
 *  every move lands on a new node and none on a gap). */
const HOVER_TARGETS = 60;
const HOVER_ROW = 10;
const DRAG_MOVES = 8;
/** The base network lane's layers — a restyle must never (re)emit any of these. */
const BASE_LANE = ["nodes", "links", "arrows", "node-halos", "phys-container", "pie"] as const;
/** Layers the shader highlight drives (network.ts HL_LAYERS): the per-hover push count is this many. */
const HL_LAYER_COUNT = 4;
// Upload allowed per hover change / per zoom frame: the ring overlay (one or a few circles, ~100 B each).
// ABSOLUTE and N-independent on purpose — a pie geometry re-upload is ~32 B × 1.6 N wedges ≈ 1 MB at
// the local default, 250× over this line; a non-vacuity check below proves that margin at the running N.
const RING_BYTES_PER_EVENT = 4 * 1024;
// Selection change: the flag columns the pushes carry, plus the ring and headroom for it.
const SELECT_SLACK_BYTES = 16 * 1024;
// LOD on: the frontier re-cut uploads per frame, screen-bounded (same ceiling as network-sweep-perf).
const LOD_UPLOAD_BYTES_PER_FRAME = 1024 * 1024;
// Wall-clock ceilings, split constant + linear (AGENTS.md §Scaling a browser guard). A hover move is a
// CPU pick (pickNodes scans the full graph with LOD off — the linear term) + one ring emit + four uniform
// writes + a render submit: measured median 0.2 ms at 20k (local headless Chromium, under load), so 1.5 ms
// is ~7x — while a base-lane re-emit on hover (the #186 shape) costs what a drag move does, ~4.4 ms.
// A drag move re-emits the whole no-LOD lane (O(nodes + links + wedges) — the pre-existing cost filed as
// a follow-up), measured median 4.4 ms at 20k and linear in N, so its linear term carries the ceiling
// (~4.5x at every N).
const HOVER_MS = perfBudget(1 + (0.5 * N) / 20_000);
const DRAG_MOVE_MS = perfBudget(4 + (16 * N) / 20_000);
const SETUP_MS = perfBudget(120_000 + N / 2);

/** Counts the instanced-layer calls reaching the WebGL backend, by layer name, without retaining the
 *  pushed arrays (a `vi.spyOn` would keep every emitted layer alive in `mock.calls`). */
class LaneCallSpy {
  readonly emits = new Map<string, number>();
  readonly styles = new Map<string, number>();
  readonly live = new Set<string>();
  /** The `selected` reference of every pie emit since the last {@link reset}. */
  pieEmitSelected: (Uint8Array | undefined)[] = [];
  /** The pie highlight pushes since the last {@link reset}. */
  pieStyles: InstancedHighlight[] = [];
  /** Total flag bytes (as the GPU's float column) the highlight pushes carried since the last reset. */
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
      if (layer.primitive === "pie") spy.pieEmitSelected.push(layer.pie.selected);
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
      if (name === "pie") spy.pieStyles.push(h);
      // Only flags that reach a live layer are uploaded (styleInstancedLayer no-ops an absent one).
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
    this.pieEmitSelected = [];
    this.pieStyles = [];
    this.styleFlagBytes = 0;
  }
  restore(): void {
    WebGLBackend.prototype.setInstancedLayer = this.origSet;
    WebGLBackend.prototype.updateInstancedLayer = this.origUpdate;
    WebGLBackend.prototype.removeInstancedLayer = this.origRemove;
    WebGLBackend.prototype.styleInstancedLayer = this.origStyle;
  }
}

/** A grid of N physical nodes; 4 in 5 hold two state nodes in different top-level modules (a pie). */
function fixture(n: number) {
  const stateToPhysical: number[] = [];
  const modules: ModulePathNode[] = [];
  const first = new Int32Array(n); // each physical node's first state node
  let wedges = 0;
  for (let p = 0; p < n; p++) {
    first[p] = stateToPhysical.length;
    modules.push({ id: stateToPhysical.length, path: [1 + (p % 3), 1] });
    stateToPhysical.push(p);
    if (p % 5 !== 4) {
      modules.push({ id: stateToPhysical.length, path: [1 + ((p + 1) % 3), 2] });
      stateToPhysical.push(p);
      wedges += 2;
    }
  }
  // Grid links between first state nodes: right neighbour + the node below ⇒ ~2 N physical links.
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
  return { graph, modules, positions, wedges };
}

const nodeAt = (col: number, row: number): number => row * COLS + col;
/** The `selected` flags of the most recent pie highlight push that carried any. */
const lastPieFlags = (lane: LaneCallSpy): Uint8Array | undefined => {
  for (let i = lane.pieStyles.length - 1; i >= 0; i--) {
    const flags = lane.pieStyles[i]?.selected;
    if (flags) return flags;
  }
  return undefined;
};
/** The first PIE node (not a single-module disc — every 5th node) at or right of (col, row). */
const pieAt = (col: number, row: number): number => {
  const p = nodeAt(col, row);
  return p % 5 === 4 ? p + 1 : p;
};
const screenOf = (p: number): [number, number] => [(p % COLS) * SPACING, Math.floor(p / COLS) * SPACING];

interface EventLeg {
  events: number;
  baseEmits: number;
  styles: number;
  pieStyles: number;
  pieFlagRewrites: number;
  gpu: GlBufferUsage;
  worstMs: number;
  medianMs: number;
}

let wedgeCount = 0;
let edgeCount = 0;
let registration: GlBufferUsage;
let pieLiveAfterBuild = false;
let hoverOff: EventLeg;
let selectOff: EventLeg & { flagBytes: number; pieFlagLength: number; pieFlagSum: number };
let zoomOff: { baseEmits: number; pieEmits: number; radiusCalls: number; strokeCalls: number; gpu: GlBufferUsage; frames: number; worstMs: number };
let dragOff: { moves: number; pieEmits: number; distinctSelected: number; sameAsSelection: boolean; radiusCalls: number; strokeCalls: number; worstMs: number; medianMs: number };
let lodOn: { pieLive: boolean; pieEmits: number; hoverBaseEmits: number; hoverEvents: number; zoomUploadPerFrame: number; frames: number; pieLiveAfter: boolean };

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor(s.length / 2)] ?? 0) : 0;
};

beforeAll(async () => {
  const gl = new GlBufferSpy();
  const lane = new LaneCallSpy();
  try {
    const fx = fixture(N);
    wedgeCount = fx.wedges;
    edgeCount = fx.graph.physical.edgeCount;
    let radiusCalls = 0;
    let strokeCalls = 0;
    const h = perfHost(W, H);
    const net = network(h, { width: W, height: H, backend: "webgl" });
    await net.whenReady();

    const atStart = gl.mark();
    net
      .style({
        sizeMode: "world",
        nodeRadius: () => {
          radiusCalls++;
          return 3;
        },
        linkStroke: () => {
          strokeCalls++;
          return "rgba(90,110,150,0.5)";
        },
      })
      .stateNetwork(fx.graph, { modules: fx.modules, view: "physical" })
      .layout({ backend: "positions", positions: fx.positions });
    net.setTransform({ k: 1, x: 0, y: 0 }); // world == screen
    net.interactive({ selectable: { multi: true }, draggable: true, hover: { others: { opacity: 0.5 } } });
    registration = gl.since(atStart);
    pieLiveAfterBuild = lane.live.has("pie");

    const r = h.getBoundingClientRect();
    const move = (x: number, y: number) =>
      h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
    const [gapX, gapY] = [SPACING / 2, HOVER_ROW * SPACING + SPACING / 2]; // between four glyphs: no node

    /** Pointer across HOVER_TARGETS consecutive nodes; the first move (ring layer appears) is a warm-up. */
    const hoverSweep = (): EventLeg => {
      const [x0, y0] = screenOf(nodeAt(1, HOVER_ROW));
      move(x0, y0);
      lane.reset();
      const before = gl.mark();
      const times: number[] = [];
      for (let j = 0; j < HOVER_TARGETS; j++) {
        const [x, y] = screenOf(nodeAt(2 + j, HOVER_ROW));
        const t0 = performance.now();
        move(x, y);
        times.push(performance.now() - t0);
      }
      const gpu = gl.since(before);
      const leg: EventLeg = {
        events: HOVER_TARGETS,
        baseEmits: lane.baseEmits(),
        styles: lane.totalStyles(),
        pieStyles: lane.pieStyles.length,
        pieFlagRewrites: lane.pieStyles.filter((u) => u.selected !== undefined).length,
        gpu,
        worstMs: Math.max(...times),
        medianMs: median(times),
      };
      move(gapX, gapY); // hover off
      return leg;
    };

    // ── LOD OFF ────────────────────────────────────────────────────────────────────────────────────
    hoverOff = hoverSweep();

    // Selection changes (select() is the programmatic twin of a click; the marquee commits the same way).
    {
      const picks = [pieAt(3, 3), pieAt(8, 6), pieAt(12, 2)];
      net.select("nodes", [nodeAt(20, 20)]); // warm-up: the ring layer appears (a one-off set change)
      lane.reset();
      const before = gl.mark();
      const times: number[] = [];
      for (const p of picks) {
        const t0 = performance.now();
        net.select("nodes", [p]);
        times.push(performance.now() - t0);
      }
      const gpu = gl.since(before);
      const lastFlags = lastPieFlags(lane);
      let sum = 0;
      if (lastFlags) for (const f of lastFlags) sum += f;
      selectOff = {
        events: picks.length,
        baseEmits: lane.baseEmits(),
        styles: lane.totalStyles(),
        pieStyles: lane.pieStyles.length,
        pieFlagRewrites: lane.pieStyles.filter((u) => u.selected !== undefined).length,
        gpu,
        worstMs: Math.max(...times),
        medianMs: median(times),
        flagBytes: lane.styleFlagBytes,
        pieFlagLength: lastFlags?.length ?? 0,
        pieFlagSum: sum,
      };
    }

    // Zoom sweep with a selection active (the dim is on, the ring lane is dynamic).
    {
      const radiusBefore = radiusCalls;
      const strokeBefore = strokeCalls;
      lane.reset();
      const before = gl.mark();
      const { worstFrameMs, frames } = sweepFrames(zoomSteps(W, H), (t) => net.setTransform(t));
      zoomOff = {
        baseEmits: lane.baseEmits(),
        pieEmits: lane.emits.get("pie") ?? 0,
        radiusCalls: radiusCalls - radiusBefore,
        strokeCalls: strokeCalls - strokeBefore,
        gpu: gl.since(before),
        frames,
        worstMs: worstFrameMs,
      };
      net.setTransform({ k: 1, x: 0, y: 0 });
    }

    // Node-drag of the selected pie: every move repaints through rebuild → lane re-emit.
    {
      const grabbed = pieAt(12, 2);
      net.select("nodes", [grabbed]);
      const flags = lastPieFlags(lane);
      lane.reset();
      const radiusBefore = radiusCalls;
      const strokeBefore = strokeCalls;
      const [gx, gy] = screenOf(grabbed);
      const ev = (type: string, x: number, y: number) =>
        h.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
      ev("pointerdown", gx, gy);
      const times: number[] = [];
      for (let m = 1; m <= DRAG_MOVES; m++) {
        const t0 = performance.now();
        ev("pointermove", gx + 4 * m, gy + 3 * m);
        times.push(performance.now() - t0);
      }
      ev("pointerup", gx + 4 * DRAG_MOVES, gy + 3 * DRAG_MOVES);
      const refs = new Set(lane.pieEmitSelected);
      dragOff = {
        moves: DRAG_MOVES,
        pieEmits: lane.emits.get("pie") ?? 0,
        distinctSelected: refs.size,
        sameAsSelection: flags !== undefined && refs.size === 1 && refs.has(flags),
        radiusCalls: radiusCalls - radiusBefore,
        strokeCalls: strokeCalls - strokeBefore,
        worstMs: Math.max(...times),
        medianMs: median(times),
      };
      net.select("nodes", null);
    }

    // ── LOD ON (physical view) ─────────────────────────────────────────────────────────────────────
    {
      lane.reset();
      net.lod({ declutter: true, maxAggregateRadius: 24 });
      const pieLive = lane.live.has("pie");
      const leg = hoverSweep();
      lane.reset();
      const before = gl.mark();
      const { frames } = sweepFrames(zoomSteps(W, H), (t) => net.setTransform(t));
      const zoom = gl.since(before);
      lodOn = {
        pieLive,
        pieEmits: lane.emits.get("pie") ?? 0,
        hoverBaseEmits: leg.baseEmits,
        hoverEvents: leg.events,
        zoomUploadPerFrame: zoom.uploadedBytes / frames,
        frames,
        pieLiveAfter: lane.live.has("pie"),
      };
    }
    net.destroy();
    h.remove();
  } finally {
    lane.restore();
    gl.restore();
  }
}, SETUP_MS);

describe(`state-network pie highlight — per-interaction cost at N=${N.toLocaleString()} physical nodes (#175)`, () => {
  it("builds a real pie lane (non-vacuity)", () => {
    expect(pieLiveAfterBuild, "the fixture drew no pie layer").toBe(true);
    expect(wedgeCount, "the fixture has too few wedges").toBeGreaterThan(N);
    expect(registration.uploadedBytes, "registration uploaded nothing — the GL spy is not observing").toBeGreaterThan(0);
    // The per-event upload ceiling only bites while a pie geometry re-upload (~32 B per wedge) is far above it.
    expect(32 * wedgeCount, "fixture too small for the per-event upload ceiling to catch a pie re-upload").toBeGreaterThan(100 * RING_BYTES_PER_EVENT);
  });

  it("LOD OFF — hover sweep: uniforms only, O(1) pushes per hover change, no geometry", () => {
    expect(hoverOff.baseEmits, "a hover re-emitted base-lane geometry").toBe(0);
    // Each hover change pushes the HL layers once (a clear + set may double it) — never O(wedges).
    expect(hoverOff.pieStyles, "the pie never received a hover push").toBeGreaterThanOrEqual(hoverOff.events);
    expect(hoverOff.styles, "uniform pushes grew beyond O(HL layers) per hover change").toBeLessThanOrEqual(2 * HL_LAYER_COUNT * hoverOff.events);
    expect(hoverOff.pieFlagRewrites, "a hover rewrote the pie's selected flags").toBe(0);
    expect(hoverOff.gpu.created, "a hover created GPU buffers").toBe(0);
    expect(hoverOff.gpu.deleted, "a hover destroyed GPU buffers").toBe(0);
    expect(
      hoverOff.gpu.uploadedBytes / hoverOff.events,
      `hover uploaded ${(hoverOff.gpu.uploadedBytes / hoverOff.events).toFixed(0)} B per move — must stay the ring's few bytes, not O(wedges)`,
    ).toBeLessThan(RING_BYTES_PER_EVENT);
    expect(hoverOff.medianMs, `hover median ${hoverOff.medianMs.toFixed(2)}ms (worst ${hoverOff.worstMs.toFixed(2)}ms)`).toBeLessThan(HOVER_MS);
  });

  it("LOD OFF — selection change: exactly the flag columns + the ring are uploaded, no geometry", () => {
    expect(selectOff.baseEmits, "a selection re-emitted base-lane geometry").toBe(0);
    expect(selectOff.pieFlagRewrites, "a selection did not refresh the pie's flags").toBe(selectOff.events);
    expect(selectOff.pieFlagLength, "the pie's flag column is not one flag per wedge").toBe(wedgeCount);
    expect(selectOff.pieFlagSum, "the selected pie's two wedges are not both flagged").toBe(2);
    expect(selectOff.flagBytes, "no flag bytes were pushed").toBeGreaterThan(0);
    expect(
      selectOff.gpu.uploadedBytes,
      `selection uploaded ${selectOff.gpu.uploadedBytes.toLocaleString()} B over ${selectOff.events} changes; the flag columns are ${selectOff.flagBytes.toLocaleString()} B`,
    ).toBeLessThanOrEqual(selectOff.flagBytes + SELECT_SLACK_BYTES * selectOff.events);
    // Sanity on the scale of that bound: the flags are 4 B per node/link/wedge, far below the geometry.
    expect(selectOff.flagBytes / selectOff.events).toBeLessThanOrEqual(4 * (N + edgeCount + wedgeCount) * 2);
  });

  it("LOD OFF — zoom sweep with a selection: the static lane never re-emits, accessors stay flat", () => {
    expect(zoomOff.baseEmits, "the static no-LOD lane re-emitted during the zoom sweep").toBe(0);
    expect(zoomOff.pieEmits, "the pie (and its per-wedge colour parse) re-ran per frame").toBe(0);
    expect(zoomOff.radiusCalls, "nodeRadius re-ran per frame").toBe(0);
    expect(zoomOff.strokeCalls, "linkStroke re-ran per frame").toBe(0);
    expect(zoomOff.gpu.created, "GPU buffers were created during the sweep").toBe(0);
    expect(zoomOff.gpu.deleted, "GPU buffers were destroyed during the sweep").toBe(0);
    expect(zoomOff.gpu.uploadedBytes / zoomOff.frames, "per-frame upload grew beyond the ring overlay").toBeLessThan(RING_BYTES_PER_EVENT);
  });

  it("LOD OFF — node-drag: each move re-emits the pie with the SAME cached flags (no O(wedges) rebuild)", () => {
    expect(dragOff.pieEmits, "the drag did not re-emit the pie once per move").toBeGreaterThanOrEqual(dragOff.moves);
    expect(dragOff.distinctSelected, "a drag move rebuilt the pie's selected flags").toBe(1);
    expect(dragOff.sameAsSelection, "the drag emitted flags other than the ones the selection built").toBe(true);
    // Position-only frames reuse the #179 style cache: no accessor re-derive per move.
    expect(dragOff.radiusCalls, "nodeRadius re-ran per drag move").toBe(0);
    expect(dragOff.strokeCalls, "linkStroke re-ran per drag move").toBe(0);
    expect(dragOff.medianMs, `drag move median ${dragOff.medianMs.toFixed(2)}ms (worst ${dragOff.worstMs.toFixed(2)}ms)`).toBeLessThan(DRAG_MOVE_MS);
  });

  it("LOD ON — the no-LOD pie is removed, and no pie work runs per hover or per zoom frame (#174)", () => {
    expect(lodOn.pieLive, "a stale no-LOD pie layer survived lod() on").toBe(false);
    expect(lodOn.pieLiveAfter, "a pie layer reappeared under LOD").toBe(false);
    expect(lodOn.pieEmits, "the LOD lane emitted a pie").toBe(0);
    expect(lodOn.hoverBaseEmits, "an LOD hover re-emitted base-lane geometry").toBe(0);
    expect(lodOn.zoomUploadPerFrame, "the LOD zoom upload is not screen-bounded").toBeLessThan(LOD_UPLOAD_BYTES_PER_FRAME);
  });
});
