import { describe, it, expect, beforeAll } from "vitest";
import { network, type NetworkStyle } from "../network.js";
import { buildGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";
import { lodStylePasses } from "../lod.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames } from "../../__tests__/engine-sweep.js";

/**
 * ENGINE-level zoom sweep for #510: a share-mode flow border on a module map, through the real
 * `net.setTransform()` on WebGL. The node guard (`flow-border-share-perf.test.ts`) drives the frontier build
 * at 1M; this one drives the engine glue, where a per-re-cut re-sum of the node flow (or a per-frame
 * re-upload) would hide.
 *
 * One engine (a second WebGL engine after a large upload stalls `whenReady`, #287), six legs:
 * {LOD on, LOD on with every module open, LOD off} × {absolute flow border, share-mode flow border}.
 * Signatures: during every sweep no LOD style pass runs (the flow is summed with the style, never per
 * frame); with LOD on the per-frame upload stays N-independent; with every module open (all N leaves re-cut
 * and re-emitted per frame: reductions can't shrink the set) the share mode's frame costs a small multiple
 * of the absolute mode's; with LOD off the static emit uploads nothing per frame.
 */

const N = perfN(50_000, { max: 1_000_000 });
const W = 640;
const H = 400;
// Measured (local headless Chromium, M-series laptop, host load 10-14; worst of best-of-3, absolute / share):
// at 50k, LOD on 0.4 / 0.3 ms, every module open 2.1 / 2.4 ms, LOD off 0 / 0; at 1M, LOD on 0.4 / 0.4 ms
// (~7 KB uploaded per frame), every module open 49.7 / 48.4 ms, LOD off 0 / 0 (nothing uploaded). Constant +
// linear ceilings as the #445 guard's, ~5-10× the measured values (docs/agents/performance.md).
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

interface Leg { uploadedBytes: number; created: number; deleted: number; worstFrameMs: number; frames: number; stylePasses: number }

let lodAbs: Leg, lodShare: Leg, openShare: Leg, openAbs: Leg, fullAbs: Leg, fullShare: Leg;
let registrationUploadedBytes = 0;

beforeAll(async () => {
  const spy = new GlBufferSpy();
  try {
    const { graph, modules, positions, extent } = fixture(N);
    // Exit flow: 0, ¼, ½, ¾ or all of each node's flow.
    const exit = Float32Array.from({ length: N }, (_, i) => ((i % 5) / 4) * graph.flow![i]!);
    const base: NetworkStyle = { nodeRadius: 3, sizeMode: "screen", linkStyle: "none", nodeFill: (i) => (i % 2 ? "#4878d0" : "#ee854a") };
    const absolute: NetworkStyle = { ...base, flowBorder: { flow: exit, scale: (v) => Math.min(3, Math.sqrt(v * N)), color: "#333" } };
    const share: NetworkStyle = { ...base, flowBorder: { share: true, flow: exit, color: "#333" } };
    const net = network(perfHost(W, H), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const atStart = spy.mark();
    net.data(graph, { modules }).style(absolute).lod({ declutter: true }).layout({ backend: "positions", positions });
    registrationUploadedBytes = spy.since(atStart).uploadedBytes;
    const k0 = (0.9 * Math.min(W, H)) / extent;
    const steps = [1, 2, 4, 8, 16, 32].map((f) => {
      const k = k0 * f;
      return { k, x: W / 2 - 0.37 * extent * k, y: H / 2 - 0.41 * extent * k };
    });
    const runLeg = (): Leg => {
      sweepFrames(steps, (t) => net.setTransform(t), 1); // warm
      const before = spy.mark();
      const passes = lodStylePasses;
      const { worstFrameMs, frames } = sweepFrames(steps, (t) => net.setTransform(t));
      const d = spy.since(before);
      return { uploadedBytes: d.uploadedBytes, created: d.created, deleted: d.deleted, worstFrameMs, frames, stylePasses: lodStylePasses - passes };
    };
    lodAbs = runLeg();
    net.style(share);
    lodShare = runLeg();
    net.lod({ expandPx: 1e-6, declutter: false }); // every module open: the frontier is all N leaves
    openShare = runLeg();
    net.style(absolute);
    openAbs = runLeg();
    net.lod(false);
    fullAbs = runLeg();
    net.style(share);
    fullShare = runLeg();
    net.destroy();
  } finally {
    spy.restore();
  }
}, SETUP_MS);

describe(`network() share-mode flow border zoom sweep at N=${N.toLocaleString()} (#510)`, () => {
  it("non-vacuity: the LOD sweep re-cut", () => {
    expect(registrationUploadedBytes).toBeGreaterThan(0);
    expect(lodShare.uploadedBytes, "the LOD sweep never re-cut").toBeGreaterThan(0);
  });

  it("reductions ON: no style pass per frame; the re-cut stays O(visible) and in place", () => {
    expect(lodShare.stylePasses, "LOD style passes during the sweep").toBe(0);
    const uploadPerFrame = lodShare.uploadedBytes / lodShare.frames;
    expect(uploadPerFrame, `${(uploadPerFrame / 1024).toFixed(0)} KB per frame`).toBeLessThan(UPLOAD_BYTES_PER_FRAME);
    expect(lodShare.created).toBeLessThan(256);
    expect(lodShare.deleted).toBeLessThan(256);
    expect(lodShare.worstFrameMs, `worst frame ${lodShare.worstFrameMs.toFixed(2)}ms`).toBeLessThan(FRAME_MS_LOD);
    expect(lodShare.worstFrameMs, `${lodShare.worstFrameMs.toFixed(2)}ms vs ${lodAbs.worstFrameMs.toFixed(2)}ms absolute`).toBeLessThan(3 * lodAbs.worstFrameMs + perfBudget(5));
  });

  it("reductions ON, every module open: no style pass per frame, and the all-leaves frame keeps its cost", () => {
    expect(openShare.stylePasses, "LOD style passes during the all-open sweep").toBe(0);
    expect(openShare.uploadedBytes, "the all-open sweep drew no more than the collapsed one").toBeGreaterThan(lodShare.uploadedBytes);
    expect(openShare.worstFrameMs, `worst frame ${openShare.worstFrameMs.toFixed(1)}ms`).toBeLessThan(FRAME_MS_ALL_OPEN);
    expect(openShare.worstFrameMs, `${openShare.worstFrameMs.toFixed(1)}ms vs ${openAbs.worstFrameMs.toFixed(1)}ms absolute`).toBeLessThan(2 * openAbs.worstFrameMs + perfBudget(5));
  });

  it("reductions OFF: the static emit uploads nothing per frame", () => {
    expect(fullShare.uploadedBytes, "full-detail sweep re-uploaded geometry").toBeLessThan(registrationUploadedBytes / 1000);
    expect(fullShare.created).toBe(0);
    expect(fullShare.worstFrameMs, `worst frame ${fullShare.worstFrameMs.toFixed(2)}ms`).toBeLessThan(FRAME_MS_STATIC);
    expect(fullShare.worstFrameMs).toBeLessThan(3 * fullAbs.worstFrameMs + perfBudget(2));
  });
});
