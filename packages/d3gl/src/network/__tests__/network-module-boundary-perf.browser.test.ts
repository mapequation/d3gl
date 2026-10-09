import { describe, it, expect, beforeAll } from "vitest";
import { Network, type NetworkLODOptions, type NetworkStyle } from "../network.js";
import { boundaryRingPickStats } from "../glyphs.js";
import type { HoverHit } from "../../map/base-engine.js";
import { buildGraph } from "../graph.js";
import type { ModuleLink, ModuleNode } from "../modules.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames } from "../../__tests__/engine-sweep.js";

/**
 * ENGINE-level zoom sweep for the module boundaries (#329): `net.setTransform()` → the dynamic lane's
 * re-cut (now also collecting the expanded modules in view) → `frontierLayers` (now also building the
 * rings and anchoring module links at them) → the in-place instanced upload. The node guard
 * (`module-boundary-perf.test.ts`) drives the pipeline functions at 1M; this one drives the glue
 * between them on the real WebGL engine, where an O(N)-per-frame cost there would hide.
 *
 * One engine, three legs (a second WebGL engine after a large upload stalls `whenReady`, #287):
 *   1. LOD on (declutter + cross-level edges), boundaries OFF — the baseline;
 *   2. the same with `moduleBoundary` ON — reductions on; per-frame upload must stay N-independent and
 *      the frame cost a small multiple of the baseline's;
 *   3. every module open (`expandPx` ~0, declutter off) with boundaries ON — reductions off: every
 *      leaf drawn, every module ringed, every module link anchored;
 *   4-6. #471: the same under a module-flow-only flow border and per-node fills — constant rings (the
 *      baseline), then `moduleBoundary: { width: (path) => …, color: "fill" }` on the sweep and with every
 *      module open. Per-module widths and colours are resolved once per (style, tree): the sweep calls
 *      the width accessor, the fill accessor and `moduleFlow` zero times, and the flow scale exactly as
 *      often as with constant rings (the collapsed glyphs' own rings call it; the rings add nothing). Measured (local headless
 *      Chromium): worst sweep frame 0.2 ms with constant and per-module rings alike, at 50k and 200k, with
 *      the same buffer churn (+42/−42 at 50k, the layer set changing); every module open 10.6 / 42.2 ms
 *      at 50k / 200k, next to leg 3's 11.6 / 42.1 ms.
 *   7-9. #476: hover sweeps through the real pointer path (`pointermove` on the host → pick → hover →
 *      the highlight lane) under `interactive({ hover: { others } })`, on per-module rings: across the
 *      zoom sweep's views (reductions ON), with every module open (reductions OFF), and with LOD off. A
 *      move tests only the rings drawn (none with LOD off); a hover change re-emits only the highlight lane
 *      (the base lane's emit count stays put, and the upload per change is a few circles), resolves no
 *      accessor, and stays within a per-move ceiling.
 * The map is `.ftree`-shaped (leaf edges inside bottom modules, module links between siblings) and laid
 * out by the nested layout, so the rings are its discs.
 */

const N = perfN(50_000, { max: 200_000 });
const W = 640;
const H = 400;
// Measured (local headless Chromium, 50k): worst frame 0.1 ms / 0.3 ms in legs 1 / 2 (the adaptive cut
// keeps the sweep's frontier small), leg 3 ~34 ms (every node and link drawn). Constant + linear terms (AGENTS
// §Tests), each ~4-6× the measured value — far below an O(N) re-derivation per frame on legs 1-2.
const FRAME_MS_LOD = perfBudget(20 + (10 * N) / 50_000);
const FRAME_MS_ALL_OPEN = perfBudget(150 + (350 * N) / 50_000);
// Per-frame upload with the boundaries on: ABSOLUTE and N-independent (rings + anchored links in view
// only). Measured ~2 KB/frame at 50k; an O(N) re-upload of the leaf instance arrays is megabytes.
const UPLOAD_BYTES_PER_FRAME = 1024 * 1024;
const SETUP_MS = perfBudget(120_000 + N / 2);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** An `.ftree`-shaped map: modules of 2-12 children down to 16-96-leaf bottom modules. */
function fixture(n: number): { graph: ReturnType<typeof buildGraph>; modules: ModuleNode[]; links: ModuleLink[] } {
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

interface Leg {
  created: number;
  deleted: number;
  uploadedBytes: number;
  worstFrameMs: number;
  frames: number;
}

let legOff: Leg;
let legOn: Leg;
let legAll: Leg;
let legFlowConst: Leg & { calls: Calls };
let legFlowFill: Leg & { calls: Calls };
let legFlowAll: Leg & { calls: Calls };
let registrationUploadedBytes = 0;
let widthCallsAtBuild = 0;

interface Calls { scale: number; fill: number; moduleFlow: number; width: number }

/** A hover leg (#476): pointer moves, hover changes, ring hits and tests, GL traffic, lane emits, accessor calls. */
interface HoverLeg {
  moves: number;
  changes: number;
  ringHits: number;
  ringTests: number;
  uploadedBytes: number;
  created: number;
  deleted: number;
  baseEmits: number;
  highlightEmits: number;
  medianMoveMs: number;
  worstMoveMs: number;
  calls: Calls;
}
let hoverSweep: HoverLeg;
let hoverAll: HoverLeg;
let hoverOff: HoverLeg;
let moduleCount = 0;

/** Counts each instanced lane's emits — the base lane (`network`) must not re-emit on a hover change. */
class Probe extends Network {
  readonly emits = new Map<string, number>();
  protected override emitInstancedLane(name: string): void {
    this.emits.set(name, (this.emits.get(name) ?? 0) + 1);
    super.emitInstancedLane(name);
  }
}
const isOpenHit = (h: HoverHit | null): boolean => !!h && typeof h.datum === "object" && h.datum !== null && "open" in h.datum && h.datum.open === true;
// Worst pointer move (#476), constant + linear terms (AGENTS §Tests). Measured (local headless Chromium): on the
// sweep 1.4 / 1.0 ms at 50k / 200k (a handful of rings drawn); every module open 2.4 / 4.8 ms (~4k / ~16.5k
// rings tested per move, and a hover change repaints the full-detail frame). The deterministic counts below
// carry the O(rings drawn) and highlight-lane-only proof; these catch an order-of-magnitude slip.
const HOVER_MOVE_MS_SWEEP = perfBudget(10 + (2 * N) / 50_000);
const HOVER_MOVE_MS_ALL_OPEN = perfBudget(20 + (10 * N) / 50_000);
// A hover change re-emits the highlight lane only: a ring or two of circles. A base-lane re-emit uploads
// kilobytes per frame on the sweep and megabytes with every module open.
const HOVER_UPLOAD_BYTES_PER_CHANGE = 1024;
const calls: Calls = { scale: 0, fill: 0, moduleFlow: 0, width: 0 };
/** The ring width by module path (an app passes the module's enter flow through its ring scale). */
const widthOf = (path: readonly number[]): number | undefined => (calls.width++, path.length % 3 === 0 ? undefined : 1 + 2 * path.length);
const PALETTE = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2"];

beforeAll(async () => {
  const spy = new GlBufferSpy();
  try {
    const { graph, modules, links } = fixture(N);
    const hostEl = perfHost(W, H);
    const net = new Probe(hostEl, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const base: NetworkLODOptions = { declutter: true, crossLevelEdges: true, maxAggregateRadius: 24 };
    const atStart = spy.mark();
    net
      .data(graph, { modules, moduleLinks: links })
      .style({ nodeRadius: 3, sizeMode: "screen", directed: true, linkStyle: "half-arrow" })
      .lod(base)
      .layout({ backend: "force", nested: { iterations: 20 } });
    registrationUploadedBytes = spy.since(atStart).uploadedBytes;
    // The nested map is a disc of radius 10·√N about the origin: sweep in toward an off-centre spot.
    const R = 10 * Math.sqrt(N);
    const k0 = (0.9 * Math.min(W, H)) / (2 * R);
    const steps = [1, 2, 4, 8, 16, 32].map((f) => {
      const k = k0 * f;
      return { k, x: W / 2 - 0.3 * R * k, y: H / 2 + 0.2 * R * k };
    });
    const runLeg = (): Leg => {
      const before = spy.mark();
      const { worstFrameMs, frames } = sweepFrames(steps, (t) => net.setTransform(t));
      const d = spy.since(before);
      return { created: d.created, deleted: d.deleted, uploadedBytes: d.uploadedBytes, worstFrameMs, frames };
    };
    const runCountedLeg = (): Leg & { calls: Calls } => {
      const at = { ...calls };
      const leg = runLeg();
      return { ...leg, calls: { scale: calls.scale - at.scale, fill: calls.fill - at.fill, moduleFlow: calls.moduleFlow - at.moduleFlow, width: calls.width - at.width } };
    };
    sweepFrames(steps, (t) => net.setTransform(t), 1); // warm the lane
    legOff = runLeg();
    net.lod({ ...base, moduleBoundary: {} });
    sweepFrames(steps, (t) => net.setTransform(t), 1); // warm: the ring layer joins the lane once
    legOn = runLeg();
    net.lod({ expandPx: 1e-6, declutter: false, crossLevelEdges: true, moduleBoundary: {} });
    sweepFrames(steps.slice(0, 2), (t) => net.setTransform(t), 1);
    legAll = runLeg();
    // #471: a module-flow-only flow border (an `.ftree` has no per-node flow) and per-node module fills.
    const flowStyle: NetworkStyle = {
      nodeRadius: 3,
      sizeMode: "screen",
      directed: true,
      linkStyle: "half-arrow",
      nodeFill: (i) => (calls.fill++, PALETTE[i % PALETTE.length]!),
      flowBorder: {
        scale: (v) => (calls.scale++, 1 + 40 * Math.sqrt(v)),
        moduleFlow: (path) => (calls.moduleFlow++, path.length % 3 === 0 ? undefined : 1 / (1 + path.length * 4)), // every third depth: none
      },
    };
    net.style(flowStyle).lod({ ...base, moduleBoundary: {} });
    sweepFrames(steps, (t) => net.setTransform(t), 1);
    legFlowConst = runCountedLeg();
    net.lod({ ...base, moduleBoundary: { width: widthOf, color: "fill" } });
    sweepFrames(steps, (t) => net.setTransform(t), 1); // warm: builds the width table once
    widthCallsAtBuild = calls.width;
    legFlowFill = runCountedLeg();
    net.lod({ expandPx: 1e-6, declutter: false, crossLevelEdges: true, moduleBoundary: { width: widthOf, color: "fill" } });
    sweepFrames(steps.slice(0, 2), (t) => net.setTransform(t), 1);
    legFlowAll = runCountedLeg();

    // #476: hover sweeps across the rings, through the real pointer path.
    const paths = new Set<string>();
    for (const m of modules) for (let d = 1; d < m.path.length; d++) paths.add(m.path.slice(0, d).join(":"));
    moduleCount = paths.size;
    let last: HoverHit | null = null;
    let changes = 0;
    let ringHits = 0;
    net.on("hover", (h) => {
      if (h?.layer !== last?.layer || h?.id !== last?.id) changes++;
      if (isOpenHit(h)) ringHits++;
      last = h;
    });
    net.interactive({ hover: { others: { opacity: 0.3 } } });
    const runHover = (views: { k: number; x: number; y: number }[], cols: number, rows: number): HoverLeg => {
      const leg: HoverLeg = { moves: 0, changes: 0, ringHits: 0, ringTests: 0, uploadedBytes: 0, created: 0, deleted: 0, baseEmits: 0, highlightEmits: 0, medianMoveMs: 0, worstMoveMs: 0, calls: { scale: 0, fill: 0, moduleFlow: 0, width: 0 } };
      const times: number[] = [];
      for (const view of views) {
        net.setTransform(view);
        const r = hostEl.getBoundingClientRect();
        const before = spy.mark();
        const at = { ...calls };
        const tests = boundaryRingPickStats.tests;
        const base = net.emits.get("network") ?? 0;
        const hl = net.emits.get("network-highlight") ?? 0;
        changes = 0;
        ringHits = 0;
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            // Whole px along a serpentine path: the pointer moves as a hand would, glyph to ring to empty space.
            const x = Math.round(((j % 2 ? cols - 1 - i : i) + 0.5) * (W / cols));
            const y = Math.round((j + 0.5) * (H / rows));
            const t0 = performance.now();
            hostEl.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
            times.push(performance.now() - t0);
          }
        }
        const d = spy.since(before);
        leg.moves += cols * rows;
        leg.changes += changes;
        leg.ringHits += ringHits;
        leg.ringTests += boundaryRingPickStats.tests - tests;
        leg.uploadedBytes += d.uploadedBytes;
        leg.created += d.created;
        leg.deleted += d.deleted;
        leg.baseEmits += (net.emits.get("network") ?? 0) - base;
        leg.highlightEmits += (net.emits.get("network-highlight") ?? 0) - hl;
        for (const key of ["scale", "fill", "moduleFlow", "width"] as const) leg.calls[key] += calls[key] - at[key];
        hostEl.dispatchEvent(new PointerEvent("pointerleave")); // the next view starts with no hover
      }
      times.sort((a, b) => a - b);
      leg.medianMoveMs = times[Math.floor(times.length / 2)] ?? 0;
      leg.worstMoveMs = times[times.length - 1] ?? 0;
      return leg;
    };
    net.lod({ ...base, moduleBoundary: { width: widthOf, color: "fill" } });
    sweepFrames(steps, (t) => net.setTransform(t), 1);
    hoverSweep = runHover(steps.slice(1), 40, 25);
    net.lod({ expandPx: 1e-6, declutter: false, crossLevelEdges: true, moduleBoundary: { width: widthOf, color: "fill" } });
    hoverAll = runHover([steps[0]!], 12, 8);
    net.lod(false);
    hoverOff = runHover([steps[0]!], 12, 8);
    net.destroy();

  } finally {
    spy.restore();
  }
}, SETUP_MS);

describe(`network() module-boundary zoom sweep at N=${N.toLocaleString()} (#329)`, () => {
  it("non-vacuity: the fixture registered, and the boundaries add real per-frame ink", () => {
    expect(registrationUploadedBytes).toBeGreaterThan(0);
    expect(legOff.uploadedBytes, "the baseline sweep never re-cut").toBeGreaterThan(0);
    expect(legOn.uploadedBytes, "rings and anchored links uploaded nothing").toBeGreaterThan(legOff.uploadedBytes);
  });

  it("reductions ON: the rings + anchored links stay O(visible) and re-upload in place", () => {
    const uploadPerFrame = legOn.uploadedBytes / legOn.frames;
    expect(uploadPerFrame, `${(uploadPerFrame / 1024).toFixed(0)} KB per frame — must stay screen-bounded, not O(N)`).toBeLessThan(UPLOAD_BYTES_PER_FRAME);
    // A set-stable re-emit updates in place. When the lane's layer SET changes (links, arrows or the
    // rings joining/leaving as modules open), its few layers are re-added — a fixed number of buffers
    // per change, N-independent (measured 45 over the baseline sweep, 73 with the ring layer), never
    // one per node.
    expect(legOn.created, `GPU buffers created during the boundary sweep (baseline ${legOff.created})`).toBeLessThan(256);
    expect(legOn.deleted, `GPU buffers destroyed during the boundary sweep (baseline ${legOff.deleted})`).toBeLessThan(256);
    expect(legOn.worstFrameMs, `worst frame ${legOn.worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS_LOD);
    expect(legOn.worstFrameMs, `the boundaries cost ${legOn.worstFrameMs.toFixed(2)}ms vs ${legOff.worstFrameMs.toFixed(2)}ms without`).toBeLessThan(3 * legOff.worstFrameMs + perfBudget(5));
  });

  it("#471 per-module rings, reductions ON: resolved once — the sweep only looks them up, in place, within budget", () => {
    // Deterministic: no accessor resolves a module's colour or flow on a frame, and the flow scale runs
    // exactly as often as with constant rings — for the collapsed glyphs' own rings, never for a boundary.
    expect(widthCallsAtBuild, "non-vacuity: the width table was built, one call per module").toBeGreaterThan(N / 100);
    expect(legFlowFill.calls.width, "width accessor calls during the sweep").toBe(0);
    expect(legFlowFill.calls.fill, "nodeFill accessor calls during the sweep").toBe(0);
    expect(legFlowFill.calls.moduleFlow, "moduleFlow calls during the sweep").toBe(0);
    expect(legFlowConst.calls.scale, "non-vacuity: the collapsed modules ring by their flow").toBeGreaterThan(0);
    expect(legFlowFill.calls.scale, "flow scale calls: the rings must add none").toBe(legFlowConst.calls.scale);
    const uploadPerFrame = legFlowFill.uploadedBytes / legFlowFill.frames;
    expect(uploadPerFrame, `${(uploadPerFrame / 1024).toFixed(0)} KB per frame — must stay screen-bounded, not O(N)`).toBeLessThan(UPLOAD_BYTES_PER_FRAME);
    expect(legFlowFill.created, `GPU buffers created (constant rings: ${legFlowConst.created})`).toBeLessThan(256);
    expect(legFlowFill.deleted, `GPU buffers destroyed (constant rings: ${legFlowConst.deleted})`).toBeLessThan(256);
    expect(legFlowFill.worstFrameMs, `worst frame ${legFlowFill.worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS_LOD);
    expect(legFlowFill.worstFrameMs, `per-module rings ${legFlowFill.worstFrameMs.toFixed(2)}ms vs constant ${legFlowConst.worstFrameMs.toFixed(2)}ms`).toBeLessThan(3 * legFlowConst.worstFrameMs + perfBudget(5));
  });

  it("#471 per-module rings, reductions OFF: every module open within the full-detail budget, nothing resolved per frame", () => {
    expect(legFlowAll.calls.width).toBe(0);
    expect(legFlowAll.calls.fill).toBe(0);
    expect(legFlowAll.calls.moduleFlow).toBe(0);
    expect(legFlowAll.uploadedBytes, "the all-open sweep drew nothing").toBeGreaterThan(legFlowFill.uploadedBytes);
    expect(legFlowAll.worstFrameMs, `every module open: worst frame ${legFlowAll.worstFrameMs.toFixed(1)}ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS_ALL_OPEN);
  });

  it("#476 hover across rings, reductions ON and OFF: O(rings drawn) per move, only the highlight lane per change", () => {
    for (const [label, leg, ceiling] of [["sweep", hoverSweep, HOVER_MOVE_MS_SWEEP], ["every module open", hoverAll, HOVER_MOVE_MS_ALL_OPEN]] as const) {
      const summary = `${label}: ${leg.moves} moves, ${leg.changes} hover changes, ${leg.ringHits} ring hits, ${(leg.ringTests / leg.moves).toFixed(0)} ring tests/move (${moduleCount} modules), ${leg.uploadedBytes} B uploaded, +${leg.created}/−${leg.deleted} buffers, median ${leg.medianMoveMs.toFixed(2)} ms / worst ${leg.worstMoveMs.toFixed(2)} ms per move`;
      // Non-vacuous: the pointer really hovered rings, and the highlight lane really re-emitted.
      expect(leg.ringHits, summary).toBeGreaterThan(0);
      expect(leg.changes, summary).toBeGreaterThan(0);
      expect(leg.highlightEmits, summary).toBeGreaterThan(0);
      // A move tests the rings the frame drew — at most one per module.
      expect(leg.ringTests, summary).toBeGreaterThan(0);
      expect(leg.ringTests / leg.moves, summary).toBeLessThanOrEqual(moduleCount);
      // A hover change re-emits the highlight lane only: no base-lane emit, a few circles uploaded per change
      // (measured ~100 B). The highlight lane's layers come and go with the hover (as they always have: an
      // emptied lane drops its layers), a fixed handful of buffers per change, never one per drawable.
      expect(leg.baseEmits, summary).toBe(0);
      expect(leg.uploadedBytes / leg.changes, summary).toBeLessThan(HOVER_UPLOAD_BYTES_PER_CHANGE);
      expect(leg.created, summary).toBeLessThan(32 * leg.changes + 32);
      // No accessor resolves a ring, a fill or a flow on a move.
      expect(leg.calls, summary).toEqual({ scale: 0, fill: 0, moduleFlow: 0, width: 0 });
      expect(leg.worstMoveMs, summary).toBeLessThan(ceiling);
    }
  });

  it("#476 hover with LOD off tests no ring", () => {
    const summary = `LOD off: ${hoverOff.moves} moves, ${hoverOff.changes} hover changes, median ${hoverOff.medianMoveMs.toFixed(2)} ms / worst ${hoverOff.worstMoveMs.toFixed(2)} ms per move`;
    expect(hoverOff.changes, summary).toBeGreaterThan(0); // non-vacuous: it hovered nodes
    expect(hoverOff.ringTests, summary).toBe(0);
    expect(hoverOff.ringHits, summary).toBe(0);
    expect(hoverOff.baseEmits, summary).toBe(0);
  });

  it("reductions OFF: every module open, ringed and anchored, within the full-detail budget", () => {

    expect(legAll.uploadedBytes, "the all-open sweep drew nothing").toBeGreaterThan(legOn.uploadedBytes);
    expect(legAll.worstFrameMs, `every module open: worst frame ${legAll.worstFrameMs.toFixed(1)}ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS_ALL_OPEN);
  });
});
