import { describe, it, expect, beforeAll } from "vitest";
import { network, type NetworkLODOptions } from "../network.js";
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
 *      leaf drawn, every module ringed, every module link anchored.
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
let registrationUploadedBytes = 0;

beforeAll(async () => {
  const spy = new GlBufferSpy();
  try {
    const { graph, modules, links } = fixture(N);
    const net = network(perfHost(W, H), { width: W, height: H, backend: "webgl" });
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
    sweepFrames(steps, (t) => net.setTransform(t), 1); // warm the lane
    legOff = runLeg();
    net.lod({ ...base, moduleBoundary: {} });
    sweepFrames(steps, (t) => net.setTransform(t), 1); // warm: the ring layer joins the lane once
    legOn = runLeg();
    net.lod({ expandPx: 1e-6, declutter: false, crossLevelEdges: true, moduleBoundary: {} });
    sweepFrames(steps.slice(0, 2), (t) => net.setTransform(t), 1);
    legAll = runLeg();
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

  it("reductions OFF: every module open, ringed and anchored, within the full-detail budget", () => {
    expect(legAll.uploadedBytes, "the all-open sweep drew nothing").toBeGreaterThan(legOn.uploadedBytes);
    expect(legAll.worstFrameMs, `every module open: worst frame ${legAll.worstFrameMs.toFixed(1)}ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS_ALL_OPEN);
  });
});
