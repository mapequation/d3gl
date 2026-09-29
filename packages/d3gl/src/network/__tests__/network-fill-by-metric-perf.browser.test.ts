import { describe, it, expect, beforeAll } from "vitest";
import { network, type NetworkStyle } from "../network.js";
import { buildGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames } from "../../__tests__/engine-sweep.js";

/**
 * ENGINE-level zoom sweep for #445: `nodeFill: { by, scale }`, a `flowBorder.color` accessor and
 * `flowBorder.moduleFlow` on a module map, through the real `net.setTransform()` on WebGL. The node guard
 * (`fill-by-metric-perf.test.ts`) drives the frontier build at 1M; this one drives the engine glue, where
 * an accessor re-run per re-cut (or a per-frame re-upload) would hide.
 *
 * One engine (a second WebGL engine after a large upload stalls `whenReady`, #287), six legs:
 * {LOD on, LOD on with every module open, LOD off} × {baseline style (categorical fill, constant ring
 * colour), the #445 style}. Signatures: during every sweep the fill scale, the ring colour accessor and
 * `moduleFlow` run ZERO times; with LOD on the per-frame upload stays N-independent; with every module
 * open (all N leaves re-cut and re-emitted per frame — reductions can't shrink the set) the new style's
 * frame costs a small multiple of the baseline's; with LOD off the static emit uploads nothing per frame.
 */

const N = perfN(50_000, { max: 200_000 });
const W = 640;
const H = 400;
// Measured (local headless Chromium, 50k, worst of best-of-3): LOD on 0.1 ms for both styles (~2 KB
// uploaded per frame), LOD off 0.0-0.1 ms (the static-emit quantum, nothing uploaded), every module open
// 2-3 ms (baseline / #445 style; every leaf in view re-cut and re-emitted, ~340 KB uploaded per frame).
// Constant + linear ceilings ~5-10× the measured values (AGENTS §Tests).
const FRAME_MS_LOD = perfBudget(20 + (10 * N) / 50_000);
const FRAME_MS_ALL_OPEN = perfBudget(15 + (15 * N) / 50_000);
const FRAME_MS_STATIC = perfBudget(4 + (4 * N) / 50_000);
const UPLOAD_BYTES_PER_FRAME = 1024 * 1024; // an O(N) re-upload of the node instance arrays is megabytes
const SETUP_MS = perfBudget(120_000 + N / 2);

/** A regular three-level module map (bottom modules of 64 leaves, 16 per mid module), laid out on a grid by module. */
function fixture(n: number) {
  const modules: ModuleNode[] = new Array<ModuleNode>(n);
  const source: number[] = [];
  const target: number[] = [];
  const positions = new Float32Array(2 * n);
  const tops = Math.ceil(n / (64 * 16));
  const cols = Math.ceil(Math.sqrt(tops));
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / 64);
    const mid = b % 16;
    const top = Math.floor(b / 16);
    modules[i] = { id: i, path: [top + 1, mid + 1, (i % 64) + 1] };
    const next = b * 64 + ((i + 1) % 64);
    source.push(i);
    target.push(next < n ? next : i);
    positions[2 * i] = (top % cols) * 400 + (mid % 4) * 90 + (i % 8) * 10;
    positions[2 * i + 1] = Math.floor(top / cols) * 400 + Math.floor(mid / 4) * 90 + Math.floor((i % 64) / 8) * 10;
  }
  const flow = Float32Array.from({ length: n }, (_, i) => (1 + (i % 7)) / n);
  const graph = buildGraph({ nodeCount: n, source, target, directed: true, nodeFlow: flow });
  return { graph, modules, positions, extent: cols * 400 };
}

interface Leg { uploadedBytes: number; created: number; deleted: number; worstFrameMs: number; frames: number; calls: number }

const calls = { scale: 0, color: 0, moduleFlow: 0 };
const total = () => calls.scale + calls.color + calls.moduleFlow;
let atStyle = { ...calls };
let lodBase: Leg, lodNew: Leg, openNew: Leg, openBase: Leg, fullBase: Leg, fullNew: Leg;
let registrationUploadedBytes = 0;

beforeAll(async () => {
  const spy = new GlBufferSpy();
  try {
    const { graph, modules, positions, extent } = fixture(N);
    const enterExit = Float32Array.from({ length: N }, (_, i) => (i % 5) / N);
    const ringW = (v: number) => Math.min(3, Math.sqrt(v * N));
    const baseline: NetworkStyle = { nodeRadius: 3, sizeMode: "screen", linkStyle: "none", nodeFill: (i) => (i % 2 ? "#4878d0" : "#ee854a"), flowBorder: { flow: enterExit, scale: ringW, color: "#333" } };
    const byMetric: NetworkStyle = {
      ...baseline,
      nodeFill: { by: "flow", scale: (v) => (calls.scale++, `rgb(${Math.min(255, Math.round(v * N * 30))}, 0, 0)`) },
      flowBorder: {
        flow: enterExit,
        scale: ringW,
        color: (v) => (calls.color++, `rgb(0, ${Math.min(255, Math.round(v * N * 30))}, 0)`),
        moduleFlow: (path) => (calls.moduleFlow++, path.length === 2 ? path[1]! / N : undefined),
      },
    };
    const net = network(perfHost(W, H), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const atStart = spy.mark();
    net.data(graph, { modules }).style(baseline).lod({ declutter: true }).layout({ backend: "positions", positions });
    registrationUploadedBytes = spy.since(atStart).uploadedBytes;
    const k0 = (0.9 * Math.min(W, H)) / extent;
    const steps = [1, 2, 4, 8, 16, 32].map((f) => {
      const k = k0 * f;
      return { k, x: W / 2 - 0.37 * extent * k, y: H / 2 - 0.41 * extent * k };
    });
    const runLeg = (): Leg => {
      sweepFrames(steps, (t) => net.setTransform(t), 1); // warm
      const before = spy.mark();
      const c0 = total();
      const { worstFrameMs, frames } = sweepFrames(steps, (t) => net.setTransform(t));
      const d = spy.since(before);
      return { uploadedBytes: d.uploadedBytes, created: d.created, deleted: d.deleted, worstFrameMs, frames, calls: total() - c0 };
    };
    lodBase = runLeg();
    net.style(byMetric);
    atStyle = { ...calls };
    lodNew = runLeg();
    net.lod({ expandPx: 1e-6, declutter: false }); // every module open: the frontier is all N leaves
    openNew = runLeg();
    net.style(baseline);
    openBase = runLeg();
    net.lod(false);
    fullBase = runLeg();
    net.style(byMetric);
    fullNew = runLeg();
    net.destroy();
  } finally {
    spy.restore();
  }
}, SETUP_MS);

describe(`network() nodeFill { by } + moduleFlow zoom sweep at N=${N.toLocaleString()} (#445)`, () => {
  it("non-vacuity: the style resolved every accessor, and the LOD sweep re-cut", () => {
    expect(registrationUploadedBytes).toBeGreaterThan(0);
    expect(atStyle.scale, "fill scale ran once per node + aggregate").toBeGreaterThan(N);
    expect(atStyle.color, "ring colour ran once per node + aggregate").toBeGreaterThan(N);
    expect(atStyle.moduleFlow, "moduleFlow ran once per module").toBeGreaterThan(N / 64);
    expect(lodNew.uploadedBytes, "the LOD sweep never re-cut").toBeGreaterThan(0);
  });

  it("reductions ON: no accessor runs per frame; the re-cut stays O(visible) and in place", () => {
    expect(lodNew.calls, "accessor calls during the LOD sweep").toBe(0);
    const uploadPerFrame = lodNew.uploadedBytes / lodNew.frames;
    expect(uploadPerFrame, `${(uploadPerFrame / 1024).toFixed(0)} KB per frame`).toBeLessThan(UPLOAD_BYTES_PER_FRAME);
    expect(lodNew.created).toBeLessThan(256);
    expect(lodNew.deleted).toBeLessThan(256);
    expect(lodNew.worstFrameMs, `worst frame ${lodNew.worstFrameMs.toFixed(2)}ms`).toBeLessThan(FRAME_MS_LOD);
    expect(lodNew.worstFrameMs, `${lodNew.worstFrameMs.toFixed(2)}ms vs ${lodBase.worstFrameMs.toFixed(2)}ms baseline`).toBeLessThan(3 * lodBase.worstFrameMs + perfBudget(5));
  });

  it("reductions ON, every module open: no accessor runs per frame, and the all-leaves frame keeps its cost", () => {
    expect(openNew.calls, "accessor calls during the all-open sweep").toBe(0);
    expect(openNew.uploadedBytes, "the all-open sweep drew no more than the collapsed one").toBeGreaterThan(lodNew.uploadedBytes);
    expect(openNew.worstFrameMs, `worst frame ${openNew.worstFrameMs.toFixed(1)}ms`).toBeLessThan(FRAME_MS_ALL_OPEN);
    expect(openNew.worstFrameMs, `${openNew.worstFrameMs.toFixed(1)}ms vs ${openBase.worstFrameMs.toFixed(1)}ms baseline`).toBeLessThan(2 * openBase.worstFrameMs + perfBudget(5));
  });

  it("reductions OFF: no accessor runs per frame, and the static emit uploads nothing per frame", () => {
    expect(fullNew.calls, "accessor calls during the full-detail sweep").toBe(0);
    expect(fullNew.uploadedBytes, "full-detail sweep re-uploaded geometry").toBeLessThan(registrationUploadedBytes / 1000);
    expect(fullNew.created).toBe(0);
    expect(fullNew.worstFrameMs, `worst frame ${fullNew.worstFrameMs.toFixed(2)}ms`).toBeLessThan(FRAME_MS_STATIC);
    expect(fullNew.worstFrameMs).toBeLessThan(3 * fullBase.worstFrameMs + perfBudget(2));
  });
});
