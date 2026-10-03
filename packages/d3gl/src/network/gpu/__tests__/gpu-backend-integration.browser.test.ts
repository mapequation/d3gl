/**
 * Integration test: `network.layout({ backend: "gpu" })` must take the real GPU path (not silently
 * fall back to the CPU worker) when the engine is created on a WebGL backend.
 *
 * This is the regression test for the bug where `gpuDevice()` returned null at layout() call time
 * because the luma.gl Device was created asynchronously — even on a `"webgl"` backend, `swapBackend`
 * is async — and the old code called `this.gpuDevice()` synchronously before `whenBackendSettled()`
 * resolved.
 *
 * Fix: `network.ts` now passes `this.whenBackendSettled().then(() => this.gpuDevice())` — a device
 * promise — to `startGpuLayout`, which waits for it before running the GPU or worker path.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { network, Network, type NetworkLayoutOptions } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { buildStateGraph } from "../../state-graph.js";
import { sharedMemoryAvailable } from "../../worker-transport.js";
import type { MainToWorker, StartMessage } from "../../worker-protocol.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";
import { WebGLBackend } from "../../../webgl/webgl-backend.js";
import { createBackend, type BackendHandle } from "../../../map/backend-factory.js";
import { WebGLDevice } from "@luma.gl/webgl";
import { GpuStream, observeGpuLayoutFrames } from "../gpu-stream.js";
import { startGpuLayout, type GpuLayoutTransport } from "../gpu-transport.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { makeTestDevice } from "./_device.js";
import { AsyncPositionReadback } from "../async-readback.js";
import { GpuNestedLayout, nestedLayoutPlan } from "../gpu-nested-layout.js";
import { nestedSolverResult, nestedSolverTopology } from "../nested-topology.js";
import { nestedLayout } from "../../nested-layout.js";
import type { LODTree } from "../../lod.js";
import { directedPartition, expectContained, linkTightness, topo, worstSeparation } from "../../__tests__/nested-fixtures.js";
import { fakeParallelCompile, hideParallelCompile } from "./_parallel-compile.js";

const W = 400;
const H = 300;

/** Build a minimal 10-node ring graph for a lightweight layout run. */
function makeRingGraph() {
  const nodeCount = 10;
  const source = new Uint32Array(nodeCount);
  const target = new Uint32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    source[i] = i;
    target[i] = (i + 1) % nodeCount;
  }
  return { nodeCount, source, target };
}

const hosts: HTMLElement[] = [];
function makeHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.width = `${W}px`;
  host.style.height = `${H}px`;
  document.body.appendChild(host);
  hosts.push(host);
  return host;
}

afterEach(() => {
  for (const h of hosts) h.remove();
  hosts.length = 0;
  vi.restoreAllMocks();
});

/** A ring with deterministic chords: coarsens into a real LOD tree (the worker-LOD fixture). */
function clustered(n: number) {
  let s = 99 >>> 0;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
    source.push(i);
    target.push((i + 1 + Math.floor(rng() * (n - 2))) % n);
  }
  return buildGraph({ nodeCount: n, source, target });
}

/**
 * A WebGL engine whose device has no `EXT_float_blend` — float render targets but no float blending, the
 * device the old check accepted (#351). luma probes every feature when it creates the device, so hiding
 * the extension from `getExtension` until the engine is ready is what such a device reports.
 */
async function engineWithoutFloatBlend() {
  const original = WebGL2RenderingContext.prototype.getExtension;
  const hide = vi.spyOn(WebGL2RenderingContext.prototype, "getExtension").mockImplementation(
    function (this: WebGL2RenderingContext, name: string) {
      return name === "EXT_float_blend" ? null : original.call(this, name);
    },
  );
  const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
  try {
    await net.whenReady();
  } finally {
    hide.mockRestore();
  }
  return net;
}

/** The layout options a worker `start` message carries — what "identical options" compares. */
function startOptions(m: MainToWorker) {
  if (m.type !== "start") return null;
  const { nodeCount, width, height, iterations, force, coarsen, multilevel, frameEvery, lod } = m;
  return { nodeCount, width, height, iterations, force, coarsen, multilevel, frameEvery, lod };
}

/** Every `start` message posted to a layout worker since `spy` was installed. */
function workerStarts(spy: { mock: { calls: [MainToWorker, ...unknown[]][] } }) {
  return spy.mock.calls.map((c) => startOptions(c[0])).filter((o) => o !== null);
}

/** The `[d3gl] … fell back to the CPU worker` warnings among `warn`'s calls. */
function fallbackWarnings(warn: { mock: { calls: unknown[][] } }): unknown[][] {
  return warn.mock.calls.filter((c) => String(c[0]).includes("fell back to the CPU worker"));
}

describe("network layout backend:'gpu' integration", () => {
  it("GPU path is taken (layoutTransport === 'gpu') on a WebGL engine", async () => {
    const host = makeHost();
    // Create a real network engine on the webgl backend. swapBackend is async, so the
    // device is NOT ready immediately — this is exactly the scenario the bug triggered.
    const net = network(host, { width: W, height: H, backend: "webgl" });

    const { buildGraph } = await import("../../graph.js");
    const g = buildGraph(makeRingGraph());

    net.data(g).style({ nodeRadius: 4 }).layout({ backend: "gpu", iterations: 5 });

    // Wait for the layout to settle (the device promise must have resolved and either the
    // GPU loop or the worker fallback must have converged).
    await net.whenSettled();

    // The transport MUST be "gpu" — not "copy" (worker) or anything else.
    expect(net.layoutTransport).toBe("gpu");

    net.destroy();
  });

  it("a warm layout (#454) glides from the positions on screen: frame by frame as it spreads out, no disc, no multilevel seed", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    // A grid of 40 × 40 ring-linked nodes, packed at a third of the force layout's scale: the warm GPU solve
    // spreads it out, as it spreads a nested map out to a force layout.
    const n = 1600;
    const g = buildGraph({ nodeCount: n, source: Array.from({ length: n }, (_, i) => i), target: Array.from({ length: n }, (_, i) => (i + 1) % n) });
    const from = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) {
      from[2 * i] = (i % 40) * 4;
      from[2 * i + 1] = Math.floor(i / 40) * 4;
    }
    net.data(g).lod(false).layout({ backend: "positions", positions: from });
    const samples: Float32Array[] = [];
    let on = true;
    const tick = (): void => {
      if (!on) return;
      samples.push(g.positions.slice());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    net.layout({ backend: "gpu", warm: true, fit: true });
    expect(Array.from(g.positions)).toEqual(Array.from(from)); // no disc, no seed placed over it
    await net.whenSettled();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    on = false;
    expect(net.layoutTransport).toBe("gpu");
    const to = g.positions.slice();
    const shift = (a: Float32Array, b: Float32Array): number => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Math.hypot((a[2 * i] ?? 0) - (b[2 * i] ?? 0), (a[2 * i + 1] ?? 0) - (b[2 * i + 1] ?? 0));
      return sum / n;
    };
    const total = shift(from, to);
    expect(total, "non-vacuity: the layout moved").toBeGreaterThan(20);
    const moved = samples.filter((p) => shift(p, from) > 0);
    expect(shift(moved[0] ?? to, from) / total, "the first frame jumped").toBeLessThan(0.15);
    let largest = 0;
    for (let i = 1; i < moved.length; i++) largest = Math.max(largest, shift(moved[i] ?? to, moved[i - 1] ?? to));
    expect(largest / total, `a jump: ${moved.map((p) => (shift(p, from) / total).toFixed(2)).join(" ")}`).toBeLessThan(0.2);
    expect(moved.length, "too few frames between the two layouts").toBeGreaterThan(8);
    net.destroy();
  });

  it("falls back gracefully (no throw, layoutTransport !== 'gpu') on a Canvas engine", async () => {
    const host = makeHost();
    // Canvas backend has no WebGL device; the GPU layout should fall back to the worker.
    const net = network(host, { width: W, height: H, backend: "canvas" });

    const { buildGraph } = await import("../../graph.js");
    const g = buildGraph(makeRingGraph());

    let threw = false;
    try {
      net.data(g).style({ nodeRadius: 4 }).layout({ backend: "gpu", iterations: 5 });
      await net.whenSettled();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // Should have fallen back to worker — not gpu
    expect(net.layoutTransport).not.toBe("gpu");
    // And it should report some transport (not "none") — the fallback ran and settled
    expect(net.layoutTransport).not.toBe("none");

    net.destroy();
  });

  // #180 N8.2: the modular-map example's exact path — lod({ modules }) BEFORE layout({ backend: "gpu" })
  // → the module-aware multilevel GPU seed. Verifies it takes the GPU path and lays same-module nodes out
  // as coherent regions (module coherence << 1) through the public API, not just the seed fn in isolation.
  it("module-aware GPU seed via lod({ modules }) → layout({ backend: 'gpu' }) lays out coherent modules", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    const { buildGraph } = await import("../../graph.js");

    // 6 planted modules × 40 nodes, round-robin (moduleOf[i] = i % K) so disc order does NOT pre-cluster.
    const K = 6, m = 40, nodeCount = K * m;
    let s = 0x1234 >>> 0;
    const rand = () => ((s = Math.imul(1664525, s) + 1013904223), (s >>> 0) / 0x100000000);
    const moduleOf = new Int32Array(nodeCount);
    const members: number[][] = Array.from({ length: K }, () => []);
    for (let i = 0; i < nodeCount; i++) { moduleOf[i] = i % K; members[i % K]!.push(i); }
    const src: number[] = [], tgt: number[] = [];
    for (let c = 0; c < K; c++) { const mem = members[c]!; for (const a of mem) for (let e = 0; e < 4; e++) { const b = mem[Math.floor(rand() * mem.length)]!; if (b !== a) { src.push(a); tgt.push(b); } } }
    for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) { src.push(members[a]![0]!); tgt.push(members[b]![0]!); }
    const g = buildGraph({ nodeCount, source: src, target: tgt });
    const rank = new Map<number, number>();
    const modules = Array.from(moduleOf, (c, id) => { const r = (rank.get(c) ?? 0) + 1; rank.set(c, r); return { id, path: [c + 1, r] }; });

    // The example's order: data → lod({ modules }) → layout({ backend: "gpu" }).
    net.data(g);
    net.lod({ modules });
    net.layout({ backend: "gpu", iterations: 200 });
    await net.whenSettled();

    expect(net.layoutTransport).toBe("gpu"); // the module-aware seed ran on the GPU path

    // Module coherence: mean intra-module pair distance / mean cross-module distance (<< 1 = coherent).
    const pos = g.positions;
    let s2 = 0xc0ffee >>> 0;
    const rng = () => ((s2 = Math.imul(1664525, s2) + 1013904223), (s2 >>> 0) / 0x100000000);
    let intra = 0, ni = 0, inter = 0, ne = 0;
    for (let k = 0; k < 6000; k++) {
      const i = Math.floor(rng() * nodeCount);
      const j = Math.floor(rng() * nodeCount);
      if (i === j) continue;
      const dx = pos[i * 2]! - pos[j * 2]!, dy = pos[i * 2 + 1]! - pos[j * 2 + 1]!;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (moduleOf[i] === moduleOf[j]) { intra += d; ni++; } else { inter += d; ne++; }
    }
    const coherence = ni && ne ? (intra / ni) / (inter / ne) : 1;
    console.log(`  [network gpu module seed] transport=${net.layoutTransport} moduleCoherence=${coherence.toFixed(3)}`);
    expect(Number.isFinite(pos[0]!)).toBe(true);
    expect(coherence).toBeLessThan(0.85);

    net.destroy();
  });

  // #206 fit-on-layout: layout({ backend: "gpu", fit: true }) must open + settle FRAMED. The GPU solve
  // centres the layout centroid at the origin, so without fit it renders at the top-left corner until it
  // settles. Drives the real trigger on a RAGGED module tree (like the map-of-modules example) and asserts
  // the settled view maps the BULK of the nodes INSIDE the viewport at a healthy fill — i.e. not the top-left
  // pile, and not the over-zoomed "all white" collapse the earlier extent-based frame produced (#206).
  // Under backend:"auto" (#375) the fit decision is the same one: "auto" resolves to the GPU here.
  it.each(["gpu", "auto"] as const)("fit:true on backend:'%s' frames a ragged module layout — bulk of nodes inside the viewport at a healthy fill", async (backend) => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    const { buildGraph } = await import("../../graph.js");

    // Ragged paths like the example: some communities top-level (depth 1), some nested (2), some deeper (3).
    const raggedPrefix = (c: number): number[] => {
      const sup = Math.floor(c / 4);
      return c % 4 === 0 ? [10000 + c] : c % 4 === 3 ? [1 + sup, 500 + sup, 200 + c] : [1 + sup, 100 + c];
    };
    const K = 12, m = 30, nodeCount = K * m;
    let s = 0x51ed >>> 0;
    const rand = () => ((s = Math.imul(1664525, s) + 1013904223), (s >>> 0) / 0x100000000);
    const members: number[][] = Array.from({ length: K }, () => []);
    for (let i = 0; i < nodeCount; i++) members[i % K]!.push(i);
    const src: number[] = [], tgt: number[] = [];
    for (let c = 0; c < K; c++) { const mem = members[c]!; for (const a of mem) for (let e = 0; e < 4; e++) { const b = mem[Math.floor(rand() * mem.length)]!; if (b !== a) { src.push(a); tgt.push(b); } } }
    for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) { src.push(members[a]![0]!); tgt.push(members[b]![0]!); }
    const g = buildGraph({ nodeCount, source: src, target: tgt });
    const rank = new Map<number, number>();
    const modules = Array.from({ length: nodeCount }, (_, id) => { const c = id % K; const r = (rank.get(c) ?? 0) + 1; rank.set(c, r); return { id, path: [...raggedPrefix(c), r] }; });

    net.data(g);
    net.lod({ modules });
    net.style({ sizeMode: "screen", nodeRadius: 4 });
    net.layout({ backend, fit: true, iterations: 200 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu");

    const t = (net as unknown as { transform: { k: number; x: number; y: number } }).transform;
    expect(Number.isFinite(t.k)).toBe(true);
    expect(t.k).toBeGreaterThan(0);

    // Map every node through the settled transform; drop the farthest few as fling-out outliers (the fit is
    // deliberately robust to them) and assert the BULK is on-screen and fills a healthy fraction of the view.
    const pos = g.positions;
    let cx = 0, cy = 0;
    for (let i = 0; i < nodeCount; i++) { cx += pos[2 * i]!; cy += pos[2 * i + 1]!; }
    cx /= nodeCount; cy /= nodeCount;
    const screen = Array.from({ length: nodeCount }, (_, i) => [t.k * pos[2 * i]! + t.x, t.k * pos[2 * i + 1]! + t.y] as [number, number]);
    const onScreen = screen.filter(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H).length;
    expect(onScreen / nodeCount).toBeGreaterThan(0.9); // ≥90% of nodes visible — not the "all white" collapse

    // Bulk bbox (2nd–98th percentile per axis) fills a healthy fraction of the view and is centred there.
    const xs = screen.map((p) => p[0]).sort((a, b) => a - b);
    const ys = screen.map((p) => p[1]).sort((a, b) => a - b);
    const lo = Math.floor(nodeCount * 0.02), hi = Math.floor(nodeCount * 0.98);
    const spanX = xs[hi]! - xs[lo]!, spanY = ys[hi]! - ys[lo]!;
    expect(Math.max(spanX, spanY)).toBeGreaterThan(0.35 * Math.min(W, H)); // fills the view, not a speck
    expect(Math.abs((t.k * cx + t.x) - W / 2)).toBeLessThan(W * 0.25); // centred, not piled at the origin
    expect(Math.abs((t.k * cy + t.y) - H / 2)).toBeLessThan(H * 0.25);

    net.destroy();
  });
});

describe("backend:'gpu' on a device without float blending (#351)", () => {
  it("falls back to the worker with the options backend:'worker' gets, streaming the LOD tree (#312, #297)", async () => {
    const net = await engineWithoutFloatBlend();
    const warn = vi.spyOn(console, "warn");
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    const g = clustered(1500);
    const opts = { multilevel: false, iterations: 25 } as const;
    net.data(g).style({ sizeMode: "screen" }).lod({ expandPx: 48, coarsen: { minNodes: 6 } });

    net.layout({ backend: "gpu", ...opts });
    expect(net.layoutTransport).toBe("copy"); // pending until the device settles
    await net.whenSettled();

    // One warning, naming the missing extension.
    const fallbacks = fallbackWarnings(warn);
    expect(fallbacks).toHaveLength(1);
    expect(String(fallbacks[0]?.[0])).toMatch(/EXT_float_blend/);
    // The live transport is the fallback worker's (#297), never "gpu".
    expect(net.layoutTransport).toBe(sharedMemoryAvailable() ? "shared" : "copy");
    // The worker streamed the LOD tree and the engine adopted it: no main-thread tree build.
    expect(net.lodSource).toBe("worker");

    const gpuStarts = workerStarts(posts);
    expect(gpuStarts).toHaveLength(1);
    expect(gpuStarts[0]?.multilevel).toBe(false); // the cold start the caller asked for (#312)
    expect(gpuStarts[0]?.lod).toBe(true);

    // The same options on backend:"worker" (same engine: never a second WebGL engine per file) start the
    // identical worker run.
    posts.mockClear();
    net.layout({ backend: "worker", ...opts });
    await net.whenSettled();
    expect(net.lodSource).toBe("worker");
    const workerRun = workerStarts(posts);
    expect(workerRun).toHaveLength(1);
    expect(gpuStarts[0]).toEqual(workerRun[0]);

    net.destroy();
  });

  it("falls back with LOD off too, keeping multilevel's default", async () => {
    const net = await engineWithoutFloatBlend();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    net.data(clustered(400)).layout({ backend: "gpu", iterations: 10 });
    await net.whenSettled();
    const starts = workerStarts(posts);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.multilevel).toBe(true); // the worker default, as for backend:"worker"
    expect(starts[0]?.lod).toBe(false);
    expect(net.lodSource).toBe("none");
    expect(net.layoutTransport).not.toBe("gpu");
    net.destroy();
  });

  it("a supported device still takes the GPU path with LOD on, its LOD worker streaming the tree (#377)", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    net.data(clustered(1500)).lod({ expandPx: 48 }).layout({ backend: "gpu", iterations: 10 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu");
    expect(workerStarts(posts)).toHaveLength(0); // no worker layout run
    // A coarsen-only worker builds the tree and refits it per frame; the engine adopts it (#377).
    expect(posts.mock.calls.map((c: [MainToWorker, ...unknown[]]) => c[0].type).filter((t) => t === "coarsen")).toHaveLength(1);
    expect(net.lodSource).toBe("worker");
    net.destroy();
  });
});

/** Every `start-nested` message posted to a layout worker since `spy` was installed: stream flag + params. */
function nestedStarts(spy: { mock: { calls: [MainToWorker, ...unknown[]][] } }) {
  return spy.mock.calls.flatMap(([m]) => (m.type === "start-nested" ? [{ stream: m.stream, params: m.params }] : []));
}

/** `a[i]`, or NaN past the end (keeps index reads typed without a non-null assertion). */
const at = (a: ArrayLike<number>, i: number): number => a[i] ?? Number.NaN;

/** Wait up to `frames` animation frames for `done()`. */
async function frameUntil(done: () => boolean, frames: number): Promise<boolean> {
  for (let f = 0; f < frames && !done(); f++) await new Promise((r) => requestAnimationFrame(r));
  return done();
}

/** A WebGL engine on a device that runs the GPU layout, ready. */
async function webglEngine() {
  const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
  await net.whenReady();
  return net;
}

/** A 60-node ring in six modules of ten: a two-level map for the nested legs. */
function nestedFixture(): { g: NetworkGraph; modules: ModuleNode[] } {
  const n = 60;
  const g = buildGraph({ nodeCount: n, source: Array.from({ length: n }, (_, i) => i), target: Array.from({ length: n }, (_, i) => (i + 1) % n) });
  const modules: ModuleNode[] = Array.from({ length: n }, (_, id) => ({ id, path: [Math.floor(id / 10) + 1, (id % 10) + 1] }));
  return { g, modules };
}

/**
 * A hub-heavy two-level map (#355), sized by leaf count: module 1 is a star, one leaf linked to 40 others,
 * so its summed link share D = ½·Σ w·share is 10, past the ≈ 1.78 the springs' momentum leaves stable
 * without the spring relaxation; module 2 is two linked hubs of 20 spokes each (D ≈ 5), the coupled shape
 * a per-slot normalisation alone does not bound. Unrelaxed, the GPU solve stayed finite on it (its local
 * positions peaked near 1e13), kept every child inside its parent and the siblings apart, and lost the
 * arrangement: the star's hub landed at 0.88 of its module's radius (the CPU: 0.37), and linked siblings
 * sat farther apart than the average pair (link tightness 1.87, the CPU's 0.81).
 */
function hubHeavy(): { g: NetworkGraph; modules: ModuleNode[]; tree: LODTree } {
  const source: number[] = [];
  const target: number[] = [];
  const modules: ModuleNode[] = [];
  let id = 0;
  const hub = id++;
  modules.push({ id: hub, path: [1, 1] });
  for (let s = 0; s < 40; s++) {
    const leaf = id++;
    modules.push({ id: leaf, path: [1, s + 2] });
    source.push(hub);
    target.push(leaf);
  }
  const a = id++;
  const b = id++;
  modules.push({ id: a, path: [2, 1] }, { id: b, path: [2, 2] });
  source.push(a);
  target.push(b);
  let rank = 3;
  for (let s = 0; s < 20; s++) {
    for (const h of [a, b]) {
      const leaf = id++;
      modules.push({ id: leaf, path: [2, rank++] });
      source.push(h);
      target.push(leaf);
    }
  }
  const g = buildGraph({ nodeCount: id, source, target });
  return { g, modules, tree: buildModuleLODTree(id, modules, g) };
}

/** Reset `g`'s positions to `from`, lay `net` out with `opts`, and return the positions it settled on. */
async function layoutFrom(net: Network, g: NetworkGraph, from: Float32Array, opts: NetworkLayoutOptions): Promise<number[]> {
  g.positions.set(from);
  net.layout(opts);
  await net.whenSettled();
  return Array.from(g.positions);
}

/** The two ways `"auto"` resolves (#375), each with the `layoutTransport` it then reports: the GPU on a
 *  supported device, and the worker on a device without float blending. */
const AUTO_RESOLUTIONS = [
  { name: "GPU", engine: webglEngine, transport: () => "gpu" },
  { name: "worker", engine: engineWithoutFloatBlend, transport: () => (sharedMemoryAvailable() ? "shared" : "copy") },
];

/**
 * `layout({ backend: "auto" })` (#375, spec §12.2): the GPU when `gpuLayoutSupport` passes for the graph,
 * else the worker, with no warning. Every decision the engine takes on the backend must then behave as
 * it does on the resolved one — fit, drag reheat, state networks, nested layouts, LOD streaming — so each
 * leg compares against `"gpu"` / `"worker"` on the same engine where it can.
 */
describe("backend:'auto' (#375)", () => {
  it("resolves to the GPU on a supported device, silently, with LOD as on backend:'gpu'", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    const warn = vi.spyOn(console, "warn");
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    net.data(clustered(1500)).lod({ expandPx: 48 }).layout({ backend: "auto", iterations: 10 });
    expect(net.layoutTransport).toBe("copy"); // pending until the device settles, as for "gpu"
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu");
    expect(workerStarts(posts)).toHaveLength(0); // no worker run
    expect(net.lodSource).toBe("worker"); // as backend:"gpu": its LOD worker streams the tree (#377)
    expect(fallbackWarnings(warn)).toHaveLength(0);
    net.destroy();
  });

  it("resolves to the worker's exact run without a warning on a device without float blending, streaming its LOD tree", async () => {
    const net = await engineWithoutFloatBlend();
    const warn = vi.spyOn(console, "warn");
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    const opts = { multilevel: false, iterations: 25 } as const;
    net.data(clustered(1500)).style({ sizeMode: "screen" }).lod({ expandPx: 48, coarsen: { minNodes: 6 } });

    net.layout({ backend: "auto", ...opts });
    await net.whenSettled();
    expect(fallbackWarnings(warn)).toHaveLength(0); // the worker is an expected outcome of "auto"
    expect(net.layoutTransport).toBe(sharedMemoryAvailable() ? "shared" : "copy");
    expect(net.lodSource).toBe("worker"); // the LOD guards saw a worker run: no main-thread tree
    const autoStarts = workerStarts(posts);
    expect(autoStarts).toHaveLength(1);

    posts.mockClear();
    net.layout({ backend: "worker", ...opts });
    await net.whenSettled();
    expect(net.lodSource).toBe("worker");
    const workerRun = workerStarts(posts);
    expect(workerRun).toHaveLength(1);
    expect(autoStarts[0]).toEqual(workerRun[0]);
    net.destroy();
  });

  // A supported device whose GPU run then fails while starting is a fault, not an expected outcome: "auto"
  // warns (with no error value to print here) and the worker still lays the graph out.
  it("still warns when the GPU run fails to start on a supported device, and lays out on the worker", async () => {
    const net = await webglEngine();
    const g = buildGraph(makeRingGraph());
    net.data(g).layout({ backend: "auto", iterations: 2 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu"); // supported, and its capability probe is now cached

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    // The next framebuffer the device creates is the GPU layout's own: its start throws `undefined` there,
    // after the support check passed (a stand-in for a driver fault that carries no error object).
    const fault = vi.spyOn(WebGL2RenderingContext.prototype, "createFramebuffer").mockImplementationOnce(() => {
      throw undefined;
    });
    net.layout({ backend: "auto", iterations: 5 });
    await net.whenSettled();
    expect(fault).toHaveBeenCalled();
    const fallbacks = fallbackWarnings(warn);
    expect(fallbacks).toHaveLength(1);
    expect(String(fallbacks[0]?.[0])).toMatch(/the GPU layout failed to start/);
    expect(fallbacks[0]).toHaveLength(1); // no `undefined` printed after the message
    expect(workerStarts(posts)).toHaveLength(1); // one worker run, not a retry
    expect(net.layoutTransport).toBe(sharedMemoryAvailable() ? "shared" : "copy");
    expect(Array.from(g.positions).every(Number.isFinite)).toBe(true);
    net.destroy();
  });

  it("resolves to the worker without a warning on a Canvas engine", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "canvas" });
    const warn = vi.spyOn(console, "warn");
    net.data(buildGraph(makeRingGraph())).layout({ backend: "auto", iterations: 5 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe(sharedMemoryAvailable() ? "shared" : "copy");
    expect(fallbackWarnings(warn)).toHaveLength(0);
    net.destroy();
  });

  it("streams instead of transitioning, as the other streaming backends do", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    net.data(buildGraph(makeRingGraph())).layout({ backend: "auto", iterations: 5, transition: 600 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu"); // a transition would report "none" (a main-thread tween)
    net.destroy();
  });

  it.each(AUTO_RESOLUTIONS)("a node drag reheats the layout 'auto' resolved to ($name): the held node tracks the cursor and its neighbour reflows", async ({ engine, transport }) => {
    const net = await engine();
    const warn = vi.spyOn(console, "warn");
    const g = buildGraph({ nodeCount: 6, source: [0, 1, 2, 3, 4], target: [1, 2, 3, 4, 5], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "auto", iterations: 30 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe(transport());
    expect(fallbackWarnings(warn)).toHaveLength(0);
    net.interactive({ draggable: true });

    // Put node 0 at the host's centre, then grab it there and drag it by (+60, -40) without releasing.
    const p = g.positions;
    const cx = W / 2, cy = H / 2;
    net.setTransform({ k: 1, x: cx - at(p, 0), y: cy - at(p, 1) });
    const [n1x, n1y] = [at(p, 2), at(p, 3)];
    const host = hosts[hosts.length - 1];
    if (!host) throw new Error("no host");
    const r = host.getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      host.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
    const [heldX, heldY] = [at(p, 0) + 60, at(p, 1) - 40];
    pointer("pointerdown", cx, cy);
    pointer("pointermove", cx + 60, cy - 40);
    expect(p[0]).toBeCloseTo(heldX, 2); // held under the cursor by the main thread, zero lag
    expect(p[1]).toBeCloseTo(heldY, 2);
    // The layout reheats around the held node: its spring neighbour moves (translate-only would not).
    const moved = await frameUntil(() => Math.hypot(at(p, 2) - n1x, at(p, 3) - n1y) > 0.5, 120);
    pointer("pointerup", cx + 60, cy - 40);
    expect(moved).toBe(true);
    expect(p[0]).toBeCloseTo(heldX, 2); // the reheat never moved the held node
    net.destroy();
  });

  it.each(AUTO_RESOLUTIONS)("streams a state network's physical graph on the transport 'auto' resolved to ($name) and derives the rosette", async ({ engine, transport }) => {
    const graph = buildStateGraph({
      stateCount: 4,
      stateToPhysical: [0, 0, 1, 2],
      source: [0, 1],
      target: [2, 3],
      nodeFlow: [1, 1, 1, 1],
      directed: false,
    });
    const modules = [{ id: 0, path: [1, 1] }, { id: 1, path: [2, 1] }, { id: 2, path: [1, 2] }, { id: 3, path: [2, 2] }];
    const net = await engine();
    const warn = vi.spyOn(console, "warn");
    net.stateNetwork(graph, { modules, view: "state" }).layout({ backend: "auto", iterations: 20 });
    await net.whenSettled();
    expect(net.layoutTransport).toBe(transport()); // streamed, not the synchronous main-thread force solve
    expect(fallbackWarnings(warn)).toHaveLength(0);
    expect(new Set(Array.from(graph.physical.positions, (v) => v.toFixed(3))).size).toBeGreaterThan(2);
    const state = graph.state.positions, phys = graph.physical.positions;
    for (let s = 0; s < graph.state.nodeCount; s++) {
      const q = at(graph.stateToPhysical, s);
      const d = Math.hypot(at(state, 2 * s) - at(phys, 2 * q), at(state, 2 * s + 1) - at(phys, 2 * q + 1));
      expect(d).toBeLessThan(200); // each state node in its own physical node's rosette
    }
    net.destroy();
  });

  it("lays a nested map out on the GPU solve 'gpu' runs, silently: cold streams, a warm re-layout with a transition reads back once (#355)", async () => {
    const { g, modules } = nestedFixture();
    const net = await webglEngine();
    net.data(g, { modules });
    const warn = vi.spyOn(console, "warn");
    const posts = vi.spyOn(Worker.prototype, "postMessage");

    net.layout({ backend: "gpu", nested: true });
    await net.whenSettled();
    const gpuCold = Array.from(g.positions);
    net.layout({ backend: "auto", nested: true });
    expect(net.layoutTransport).toBe("copy"); // pending until the device settles, as for "gpu"
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu");
    expect(Array.from(g.positions)).toEqual(gpuCold); // the same solve, bitwise

    // The Navigator's re-cluster: a warm re-layout with a transition, from the same map on both backends.
    const map = g.positions.slice();
    const gpuWarm = await layoutFrom(net, g, map, { backend: "gpu", nested: { warm: true }, transition: 50 });
    const autoWarm = await layoutFrom(net, g, map, { backend: "auto", nested: { warm: true }, transition: 50 });
    expect(net.layoutTransport).toBe("gpu"); // the transition's handle reports the solve's transport (#297)
    expect(autoWarm).toEqual(gpuWarm);
    expect(autoWarm).not.toEqual(Array.from(map)); // it did re-lay the map out
    expect(nestedStarts(posts)).toHaveLength(0); // never the worker's nested run
    expect(fallbackWarnings(warn)).toHaveLength(0);
    net.destroy();
  });

  it("resolves a nested layout to the worker's exact run without a warning on a device without float blending (cold streams, warm + transition lands in one frame)", async () => {
    const { g, modules } = nestedFixture();
    const net = await engineWithoutFloatBlend();
    net.data(g, { modules });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posts = vi.spyOn(Worker.prototype, "postMessage");

    net.layout({ backend: "worker", nested: true });
    await net.whenSettled();
    const workerCold = nestedStarts(posts);
    const workerPositions = Array.from(g.positions);
    const workerTransport = net.layoutTransport;
    posts.mockClear();
    net.layout({ backend: "auto", nested: true });
    await net.whenSettled();
    const autoCold = nestedStarts(posts);
    expect(autoCold).toHaveLength(1);
    expect(autoCold[0]?.stream).toBe(true); // a cold layout streams one frame per depth
    expect(autoCold).toEqual(workerCold);
    expect(Array.from(g.positions)).toEqual(workerPositions);
    expect(net.layoutTransport).toBe(workerTransport);

    // A warm re-layout with a transition posts only the final layout (#328), then eases to it, as on "worker".
    const map = g.positions.slice();
    const workerWarm = await layoutFrom(net, g, map, { backend: "worker", nested: { warm: true }, transition: 50 });
    posts.mockClear();
    const autoWarm = await layoutFrom(net, g, map, { backend: "auto", nested: { warm: true }, transition: 50 });
    const autoWarmStarts = nestedStarts(posts);
    expect(autoWarmStarts).toHaveLength(1);
    expect(autoWarmStarts[0]?.stream).toBe(false);
    expect(autoWarm).toEqual(workerWarm);
    expect(fallbackWarnings(warn)).toHaveLength(0); // the worker is an expected outcome of "auto"

    // "gpu" on the same device takes the same worker run, with the one warning "auto" leaves out.
    net.layout({ backend: "gpu", nested: true });
    await net.whenSettled();
    expect(fallbackWarnings(warn)).toHaveLength(1);
    net.destroy();
  });

  // A supported device whose nested GPU solve then fails is a fault, not an expected outcome: "auto" warns,
  // and the worker lays the map out with the same delivery — here the Navigator's warm re-layout with a
  // transition, so nothing of the failed solve lands and the CPU's warm map is eased to.
  it.each([
    {
      fault: "stops before its final harvest",
      reason: /the GPU nested layout fell back to the CPU worker: the GPU solve stopped/,
      // The harvest refuses the copy, as it does when the reductions come back non-finite.
      inject: () => vi.spyOn(AsyncPositionReadback.prototype, "harvest").mockReturnValue(false),
    },
    {
      fault: "throws while starting",
      reason: /the GPU nested layout fell back to the CPU worker: the GPU nested layout failed to start/,
      // A driver fault that carries no error object.
      inject: () => vi.spyOn(GpuStream.prototype, "start").mockImplementationOnce(() => {
        throw undefined;
      }),
    },
  ])("still warns when the nested GPU solve $fault, and the worker lays out the warm map with its transition", async ({ reason, inject }) => {
    const { g, modules } = nestedFixture();
    const net = await webglEngine();
    net.data(g, { modules });
    net.layout({ backend: "auto", nested: true });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu"); // supported
    const map = g.positions.slice();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workerWarm = await layoutFrom(net, g, map, { backend: "worker", nested: { warm: true }, transition: 50 });

    const posts = vi.spyOn(Worker.prototype, "postMessage");
    inject();
    const autoWarm = await layoutFrom(net, g, map, { backend: "auto", nested: { warm: true }, transition: 50 });
    const fallbacks = fallbackWarnings(warn);
    expect(fallbacks).toHaveLength(1);
    expect(String(fallbacks[0]?.[0])).toMatch(reason);
    expect(fallbacks[0]).toHaveLength(1); // no `undefined` printed after the message
    const starts = nestedStarts(posts);
    expect(starts).toHaveLength(1); // one worker run, not a retry
    expect(starts[0]?.stream).toBe(false); // the warm + transition delivery kept: only the final layout
    expect(autoWarm).toEqual(workerWarm);
    expect(net.layoutTransport).toBe("copy"); // the worker's transport
    net.destroy();
  });

  // What the Navigator hit on a hub-heavy tree: a cold streaming solve that paints GPU frames, then goes
  // non-finite. The worker then streams the map from scratch, and nothing of the GPU solve lands after it.
  it("still warns when a cold nested GPU solve goes non-finite mid-stream, and the worker streams the map from scratch", async () => {
    const { g, modules } = nestedFixture();
    const net = await webglEngine();
    net.data(g, { modules });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    net.layout({ backend: "worker", nested: true });
    await net.whenSettled();
    const workerCold = nestedStarts(posts);
    const workerPositions = Array.from(g.positions);
    posts.mockClear();

    // The first two harvests land (GPU frames paint), then the harvest refuses the copy, as it does when
    // the reductions come back non-finite.
    const harvest = AsyncPositionReadback.prototype.harvest;
    let harvests = 0;
    vi.spyOn(AsyncPositionReadback.prototype, "harvest").mockImplementation(function (this: AsyncPositionReadback, positions, stats) {
      return ++harvests <= 2 ? Reflect.apply(harvest, this, [positions, stats]) : false;
    });
    const harvested: boolean[] = []; // per GPU frame (the stream reuses its sample object)
    const gpuFrames = vi.fn((sample: { harvested: boolean }) => harvested.push(sample.harvested));
    const unobserve = observeGpuLayoutFrames(gpuFrames);
    try {
      g.positions.fill(0);
      net.layout({ backend: "auto", nested: true });
      await net.whenSettled();
    } finally {
      unobserve();
    }
    expect(harvests).toBe(3); // two streamed frames, then the refusal stopped the stream
    expect(harvested.filter(Boolean)).toHaveLength(2);
    const fallbacks = fallbackWarnings(warn);
    expect(fallbacks).toHaveLength(1);
    expect(String(fallbacks[0]?.[0])).toMatch(/fell back to the CPU worker: the GPU solve stopped: the layout became non-finite/);
    const starts = nestedStarts(posts);
    expect(starts).toEqual(workerCold); // one worker run, the cold streaming one (stream: true)
    expect(starts[0]?.stream).toBe(true);
    // No GPU frame after the worker started, and the worker's map is what lands.
    const workerStart = posts.mock.invocationCallOrder[posts.mock.calls.findIndex(([m]) => m.type === "start-nested")] ?? 0;
    expect(Math.max(...gpuFrames.mock.invocationCallOrder)).toBeLessThan(workerStart);
    expect(Array.from(g.positions)).toEqual(workerPositions);
    expect(net.layoutTransport).toBe("copy");
    net.destroy();
  });

  // The merge gate of "auto"'s nested routing (#375): a tree with hubs must lay out on the GPU and keep the
  // layout's invariants — every child inside its parent, siblings apart (as far as the CPU layout keeps
  // them on the same tree), linked siblings close (held to the CPU's, as the GPU nested tests hold a warm
  // start). Unrelaxed, the GPU solve's Jacobi springs overshot at a hub (#355): on web-NotreDame's directed
  // tree (D up to 135) it went non-finite and "auto" fell back to the worker with a warning — the directed
  // partition here is that shape; on the hub-heavy map (D = 10) it stayed finite, so nothing fell back or
  // warned, and the arrangement was lost. The spring relaxation (`NESTED_SPRING_GAIN_MAX`) bounds both.
  it.each<{ name: string; map: () => { g: NetworkGraph; modules: ModuleNode[]; tree: LODTree } }>([
    { name: "a hub-heavy map (leaf-count sizes)", map: hubHeavy },
    {
      name: "a directed partition (PageRank flow sizes: web-NotreDame's small hubs)",
      map: () => {
        const { modules, source, target, flow } = directedPartition();
        const g = buildGraph({ nodeCount: flow.length, source, target, directed: true, nodeFlow: flow });
        return { g, modules, tree: buildModuleLODTree(g.nodeCount, modules, g) };
      },
    },
  ])("lays $name out on the GPU under 'auto' and keeps its invariants (#355)", async ({ map }) => {
    const { g, modules, tree } = map();
    const net = await webglEngine();
    const device = await makeTestDevice();
    try {
      net.data(g, { modules });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      net.layout({ backend: "auto", nested: true });
      await net.whenSettled();
      expect(fallbackWarnings(warn), "the GPU nested solve fell back to the worker").toEqual([]);
      expect(net.layoutTransport).toBe("gpu");
      // The map "auto" landed is the GPU solve's (the engine's parameters: the root radius, the graph's sizes).
      const params = { radius: 10 * Math.sqrt(g.nodeCount), size: g.flow ?? undefined };
      const solver = nestedSolverTopology(topo(tree), params);
      const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver));
      const positions = new Float32Array(2 * solver.leafCount);
      const discs = new Float32Array(4 * (solver.treeSize - solver.leafCount));
      try {
        layout.runTicks(solver.iterations);
        layout.readComposed(positions, discs);
      } finally {
        layout.destroy();
      }
      const out = nestedSolverResult(solver, positions, discs, undefined, false);
      expect(Array.from(g.positions)).toEqual(Array.from(out.positions));
      const cpu = nestedLayout(topo(tree), params);
      expectContained(tree, out);
      expect(worstSeparation(tree, out), "siblings apart").toBeGreaterThanOrEqual(Math.min(0.98, worstSeparation(tree, cpu) - 0.02));
      expect(linkTightness(tree, out), "linked siblings' distance over the average pair's").toBeLessThan(linkTightness(tree, cpu) + 0.02);
    } finally {
      device.destroy();
      net.destroy();
    }
  });
});

describe("backend:'gpu' multilevel seed for a plain graph (#353, #312)", () => {
  /** Every `coarsen` message posted to a layout worker since `spy` was installed. */
  function coarsenPosts(spy: { mock: { calls: [MainToWorker, ...unknown[]][] } }) {
    return spy.mock.calls.map((c) => c[0]).filter((m) => m.type === "coarsen");
  }

  it("seeds from the graph's coarsening, built in a worker, and paints the seed first; multilevel:false keeps the disc", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    const harvests: number[] = [];
    const unobserve = observeGpuLayoutFrames((s) => {
      if (s.harvested) harvests.push(s.harvestedTicks);
    });
    try {
      net.data(clustered(1500)).layout({ backend: "gpu", iterations: 20 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      // A seed-only worker (LOD off): it coarsens, sends the plan, and no worker layout runs.
      const seeded = coarsenPosts(posts);
      expect(seeded).toHaveLength(1);
      expect(seeded[0]?.type === "coarsen" && seeded[0].seed).toEqual({ width: W, height: H });
      expect(seeded[0]?.type === "coarsen" && seeded[0].lod).toBe(false);
      expect(workerStarts(posts)).toHaveLength(0);
      expect(harvests[0], "the first frame is not the seed").toBe(0);

      posts.mockClear();
      harvests.length = 0;
      net.layout({ backend: "gpu", iterations: 20, multilevel: false });
      await net.whenSettled();
      expect(coarsenPosts(posts)).toHaveLength(0); // no coarsening: a cold start from the disc
      expect(harvests[0]).toBeGreaterThan(0); // no seed frame
    } finally {
      unobserve();
      net.destroy();
    }
  });

  it("with LOD on, the LOD worker's one coarsening builds both the seed and the tree", async () => {
    const net = network(makeHost(), { width: W, height: H, backend: "webgl" });
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    try {
      net.data(clustered(1500)).lod({ expandPx: 48 }).layout({ backend: "gpu", iterations: 10 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      const coarsen = coarsenPosts(posts);
      expect(coarsen).toHaveLength(1);
      expect(coarsen[0]?.type === "coarsen" && coarsen[0].lod).toBe(true);
      expect(coarsen[0]?.type === "coarsen" && coarsen[0].seed).toEqual({ width: W, height: H });
      expect(net.lodSource).toBe("worker");
    } finally {
      net.destroy();
    }
  });
});

describe("backend:'gpu' whose streaming readback fails to build (#352)", () => {
  // Built at once (no KHR_parallel_shader_compile), a failed start reports only the worker. After a parallel
  // compile (#385) the run reported "gpu" when the compile started, so it moves to the worker: "gpu", "worker".
  for (const path of [
    { name: "built at once", parallel: false, reports: ["worker"] },
    { name: "after a parallel compile (#385)", parallel: true, reports: ["gpu", "worker"] },
  ] as const) {
    it(`falls back to the worker and frees the solver — ${path.name}: reports ${path.reports.join(", ")}`, async () => {
      const compile = path.parallel ? fakeParallelCompile(1) : hideParallelCompile();
      const device = await makeTestDevice();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const destroy = vi.spyOn(GpuForceLayout.prototype, "destroy");
      // The solver builds; then every buffer creation fails — the readback's pack passes' buffers or its
      // PBOs — so the stream cannot be built.
      let failBuffers = false;
      const createBuffer = WebGL2RenderingContext.prototype.createBuffer;
      vi.spyOn(WebGL2RenderingContext.prototype, "createBuffer").mockImplementation(function (this: WebGL2RenderingContext) {
        if (failBuffers) throw new Error("out of GPU memory");
        return createBuffer.call(this);
      });
      const hold = GpuForceLayout.prototype.hold;
      vi.spyOn(GpuForceLayout.prototype, "hold").mockImplementation(function (this: GpuForceLayout, heat: number) {
        hold.call(this, heat);
        failBuffers = true; // the disc-seeded run holds its heat right before it builds the stream
      });
      const reports: GpuLayoutTransport[] = [];
      const g = buildGraph(makeRingGraph());
      try {
        // A disc-seeded run (`multilevel: false`): it holds full heat right before building the stream.
        const handle = startGpuLayout(Promise.resolve(device), g, { width: W, height: H, iterations: 5, multilevel: false }, () => {}, undefined, (t) => {
          reports.push(t);
          failBuffers = false;
        });
        await handle.settled;
        expect(reports).toEqual([...path.reports]);
        expect(handle.transport).toBe("worker");
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls.filter((c) => String(c[0]).includes("failed to start"))).toHaveLength(1);
        handle.stop();
      } finally {
        failBuffers = false;
        compile.restore();
        device.destroy();
      }
    });
  }
});

describe("network layout backend:'gpu' — context loss mid-run (#352, #311)", () => {
  it("stops the GPU loop, warns once and continues warm on the worker, which settles", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posted = workerPosts();
    let frames = 0;
    let harvested = -1;
    const unobserve = observeGpuLayoutFrames((s) => {
      frames++;
      if (s.harvested) harvested = s.harvestedTicks;
    });
    try {
      // Long enough that the loss lands mid-run.
      const budget = 800;
      net.data(clustered(3000)).layout({ backend: "gpu", iterations: budget });
      const settled = net.whenSettled();
      await until(() => frames >= 5 && harvested > 0, "a few GPU frames");
      expect(net.layoutTransport).toBe("gpu");
      const ticks = harvested;

      // The engine's WebGL canvas: getContext returns the context the engine already holds.
      const canvas = host.querySelector("canvas");
      const gl = canvas?.getContext("webgl2") ?? null;
      expect(gl).not.toBeNull();
      const lose = gl?.getExtension("WEBGL_lose_context");
      expect(lose).toBeTruthy();
      lose?.loseContext();

      await settled; // resolves: a lost context never signals its fences, the run must not wait on them
      const lost = warn.mock.calls.filter((c) => String(c[0]).includes("context was lost"));
      expect(lost).toHaveLength(1);
      expect(String(lost[0]?.[0])).toMatch(/continues on the CPU worker/);
      // The GPU loop has stopped: no further GPU frames.
      const after = frames;
      for (let i = 0; i < 10; i++) await nextFrame();
      expect(frames).toBe(after);
      // The worker continued warm: the ticks left, from the last harvested positions, no seed (#311).
      const start = startOf(posted);
      expect(start?.warm).toBeDefined();
      expect(start?.iterations).toBe(budget - ticks);
      expect(net.layoutTransport).toBe(sharedMemoryAvailable() ? "shared" : "copy");
    } finally {
      unobserve();
      net.destroy();
    }
  });
});

/** The layout-worker messages posted from now on, cloned at post time (as the worker receives them). */
function workerPosts(): MainToWorker[] {
  const posted: MainToWorker[] = [];
  const post = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message: MainToWorker) {
    posted.push(structuredClone(message));
    post.call(this, message);
  });
  return posted;
}

function startOf(posted: MainToWorker[]): StartMessage | undefined {
  const start = posted.find((m) => m.type === "start");
  return start?.type === "start" ? start : undefined;
}

/** Wait (in animation frames) until `done()` holds; fails the test after `frames` frames. */
async function until(done: () => boolean, what: string, frames = 900): Promise<void> {
  for (let i = 0; i < frames && !done(); i++) await nextFrame();
  expect(done(), `timed out waiting for ${what}`).toBe(true);
}

/** A plain drag from host-relative (x0, y0) to (x1, y1), as the engine's node drag receives it. */
function drag(host: HTMLElement, x0: number, y0: number, x1: number, y1: number): void {
  const r = host.getBoundingClientRect();
  const ev = (type: string, x: number, y: number): boolean =>
    host.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
  ev("pointerdown", x0, y0);
  ev("pointermove", x1, y1);
  ev("pointerup", x1, y1);
}

/**
 * Drag node 0 of `g` (centred in the view first) and wait until the layout reflows: the drag must reach a
 * live layout run (a `pin` message to its worker) and move nodes beyond the one held. The engine must have
 * had `interactive({ draggable: true })` while on WebGL: a network that is on Canvas/SVG when it is made
 * interactive attaches no pointer listeners (the instanced lane's registration does), a separate issue.
 */
async function dragReflows(net: Network, host: HTMLElement, g: NetworkGraph, posted: MainToWorker[]): Promise<void> {
  const x0 = g.positions[0] ?? 0;
  const y0 = g.positions[1] ?? 0;
  net.setTransform({ k: 1, x: W / 2 - x0, y: H / 2 - y0 });
  const before = g.positions.slice();
  const pins = posted.filter((m) => m.type === "pin").length;
  drag(host, W / 2, H / 2, W / 2 + 60, H / 2 - 40);
  expect(posted.filter((m) => m.type === "pin").length, "the drag reached no layout worker").toBeGreaterThan(pins);
  const moved = (): number => {
    let n = 0;
    for (let i = 0; i < g.nodeCount; i++) if (g.positions[i * 2] !== before[i * 2] || g.positions[i * 2 + 1] !== before[i * 2 + 1]) n++;
    return n;
  };
  await until(() => moved() > 1, "the rest of the layout to reflow around the dragged node");
}

describe("backend:'gpu' across a render-backend swap (#311)", () => {
  it("WebGL → Canvas mid-run: frees the GPU layout before its device goes, continues warm on the worker; a drag reflows", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posted = workerPosts();
    const order: string[] = [];
    const destroyLayout = GpuForceLayout.prototype.destroy;
    vi.spyOn(GpuForceLayout.prototype, "destroy").mockImplementation(function (this: GpuForceLayout) {
      order.push("layout");
      destroyLayout.call(this);
    });
    const destroyBackend = WebGLBackend.prototype.destroy;
    vi.spyOn(WebGLBackend.prototype, "destroy").mockImplementation(function (this: WebGLBackend) {
      order.push(`backend (context ${this.gpuDevice instanceof WebGLDevice && this.gpuDevice.gl.isContextLost() ? "lost" : "alive"})`);
      destroyBackend.call(this);
    });
    let harvested = -1;
    let gpuFrames = 0;
    const unobserve = observeGpuLayoutFrames((s) => {
      gpuFrames++;
      if (s.harvested) harvested = s.harvestedTicks;
    });
    try {
      const g = clustered(1500);
      const budget = 1000;
      // A cold start (no multilevel seed, #353), whose held heat the worker continues.
      net.data(g).style({ nodeRadius: 6 }).interactive({ draggable: true }).layout({ backend: "gpu", iterations: budget, multilevel: false });
      await until(() => harvested > 0, "a GPU harvest");
      expect(net.layoutTransport).toBe("gpu");
      const ticks = harvested;
      const settledBefore = net.whenSettled();

      net.setBackend("canvas");
      await net.whenReady();
      // The pre-swap hook stopped the GPU layout while the WebGL backend (and its device) was alive.
      expect(order).toEqual(["layout", "backend (context alive)"]);
      await until(() => startOf(posted) !== undefined, "the worker start");
      const start = startOf(posted);
      expect(start?.iterations, "the worker continues with the ticks left, not the whole budget").toBe(budget - ticks);
      expect(start?.warm).toEqual(expect.objectContaining({ heat: 1, decaying: false })); // a cold start's held heat
      expect(net.layoutTransport).toBe(sharedMemoryAvailable() ? "shared" : "copy");
      expect(net.whenSettled(), "the engine's layout handle is the same object").toBe(settledBefore);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("after a render-backend swap"))).toHaveLength(1);
      const frames = gpuFrames;
      await net.whenSettled();
      expect(gpuFrames, "the GPU loop kept running after the swap").toBe(frames);

      await dragReflows(net, host, g, posted);
    } finally {
      unobserve();
      net.destroy();
    }
  });

  it("WebGL → SVG after it settled: an idle worker takes over, so a drag still reflows", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const g = clustered(600);
      net.data(g).style({ nodeRadius: 6 }).interactive({ draggable: true }).layout({ backend: "gpu", iterations: 40 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      const posted = workerPosts();
      const destroy = vi.spyOn(GpuForceLayout.prototype, "destroy");

      net.setBackend("svg");
      await net.whenReady();
      expect(destroy).toHaveBeenCalledTimes(1);
      await until(() => startOf(posted) !== undefined, "the idle worker start");
      expect(startOf(posted)?.iterations, "idle: no ticks left").toBe(0);
      expect(startOf(posted)?.warm).toBeDefined();
      expect(net.layoutTransport).toBe(sharedMemoryAvailable() ? "shared" : "copy");

      await dragReflows(net, host, g, posted);
    } finally {
      net.destroy();
    }
  });

  it("WebGL → auto: continues warm on the GPU of the upgraded WebGL backend, with no worker", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const posted = workerPosts();
    const destroy = vi.spyOn(GpuForceLayout.prototype, "destroy");
    let harvested = -1;
    const harvests: number[] = [];
    const unobserve = observeGpuLayoutFrames((s) => {
      if (!s.harvested) return;
      harvested = s.harvestedTicks;
      harvests.push(s.harvestedTicks);
    });
    try {
      const budget = 600;
      // Counts ticks, so no convergence stop (#376) may cut the budget short: without repulsion the model has
      // no equilibrium spacing and the stop never arms (as on the CPU); a cold start, no multilevel seed (#353).
      net.data(clustered(1500)).layout({ backend: "gpu", iterations: budget, multilevel: false, force: { repulsion: 0 } });
      await until(() => harvested > 0, "a GPU harvest");
      const ticks = harvested;

      net.setBackend("auto"); // a Canvas placeholder now, the WebGL upgrade in the background
      expect(destroy).toHaveBeenCalledTimes(1); // the pre-swap hook ran for the placeholder install
      harvests.length = 0;
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      expect(startOf(posted), "no worker ran").toBeUndefined();
      // The run on the upgraded device harvests its final copy at exactly the ticks that were left.
      expect(harvests[harvests.length - 1]).toBe(budget - ticks);
    } finally {
      unobserve();
      net.destroy();
    }
  });

  it("WebGL → auto after it settled: idles on the GPU of the upgraded backend, so a drag reflows there", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const posted = workerPosts();
    let gpuFrames = 0;
    const unobserve = observeGpuLayoutFrames(() => {
      gpuFrames++;
    });
    try {
      const g = clustered(600);
      net.data(g).style({ nodeRadius: 6 }).interactive({ draggable: true }).layout({ backend: "gpu", iterations: 40 });
      await net.whenSettled();
      const settledAt = g.positions.slice();
      const starts = vi.spyOn(GpuStream.prototype, "start");
      const ticks = vi.spyOn(GpuForceLayout.prototype, "beginTick");

      net.setBackend("auto"); // a Canvas placeholder now, the WebGL upgrade in the background
      await until(() => starts.mock.calls.length === 1, "the GPU run on the upgraded device");
      expect(net.layoutTransport).toBe("gpu");
      for (let i = 0; i < 10; i++) await nextFrame();
      expect(ticks, "an idle run ticks").not.toHaveBeenCalled();
      expect(Array.from(g.positions), "the settled layout moved").toEqual(Array.from(settledAt));

      const x0 = g.positions[0] ?? 0;
      const y0 = g.positions[1] ?? 0;
      net.setTransform({ k: 1, x: W / 2 - x0, y: H / 2 - y0 });
      const frames = gpuFrames;
      drag(host, W / 2, H / 2, W / 2 + 60, H / 2 - 40);
      const moved = (): number => {
        let n = 0;
        for (let i = 0; i < g.nodeCount; i++) if (g.positions[i * 2] !== settledAt[i * 2] || g.positions[i * 2 + 1] !== settledAt[i * 2 + 1]) n++;
        return n;
      };
      await until(() => moved() > 1, "the rest of the layout to reflow around the dragged node");
      expect(ticks, "the drag reflowed without GPU ticks").toHaveBeenCalled();
      expect(gpuFrames).toBeGreaterThan(frames);
      expect(startOf(posted), "a worker ran").toBeUndefined();
    } finally {
      unobserve();
      net.destroy();
    }
  });

  it("WebGL → auto, then WebGL picked before the upgrade lands: continues on the GPU of the picked backend", async () => {
    const host = makeHost();
    const net = new PrebuiltUpgradeNetwork(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posted = workerPosts();
    let harvested = -1;
    const unobserve = observeGpuLayoutFrames((s) => {
      if (s.harvested) harvested = s.harvestedTicks;
    });
    try {
      net.data(clustered(1500)).layout({ backend: "gpu", iterations: 300 });
      await until(() => harvested > 0, "a GPU harvest");
      // The upgrade's device is ready at once, so the superseded upgrade ends while the Canvas placeholder is
      // still live: before the picked backend has made its own device.
      net.upgradeWith = createBackend("webgl", host, W, H);
      await net.upgradeWith;
      net.setBackend("auto");
      net.setBackend("webgl");
      await net.whenReady();
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      expect(startOf(posted), "the layout went to the worker on a WebGL backend").toBeUndefined();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("CPU worker"))).toHaveLength(0);
    } finally {
      unobserve();
      net.destroy();
    }
  });

  it("Canvas → WebGL: a GPU layout that fell back to the worker keeps its worker run", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "canvas" });
    await net.whenReady();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const posted = workerPosts();
    const ticks = vi.spyOn(GpuForceLayout.prototype, "beginTick");
    try {
      net.data(clustered(1500)).layout({ backend: "gpu", iterations: 300 });
      await until(() => startOf(posted) !== undefined, "the fallback worker start");
      net.setBackend("webgl");
      await net.whenReady();
      await net.whenSettled();
      expect(posted.filter((m) => m.type === "start"), "a second worker was started").toHaveLength(1);
      expect(posted.some((m) => m.type === "stop"), "the worker run was stopped").toBe(false);
      expect(ticks, "a GPU run was started").not.toHaveBeenCalled();
      expect(net.layoutTransport).toBe(sharedMemoryAvailable() ? "shared" : "copy");
    } finally {
      net.destroy();
    }
  });

  it("a settled layout moved to an idle worker leaves the main-thread LOD fallback armed, as a settled worker run does", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      net.data(clustered(1500)).lod({ source: "structure" }).layout({ backend: "gpu", iterations: 40 });
      await net.whenSettled();
      expect(net.layoutTransport).toBe("gpu");
      net.setBackend("canvas");
      await net.whenReady();
      await until(() => net.lodSource === "worker", "the idle worker's LOD tree");
      net.setBackend("webgl");
      await net.whenReady();
      // Reconfiguring LOD drops the worker's tree and nothing streams another (the worker is idle), so the
      // main thread builds one, as after a settled `backend: "worker"` run.
      net.lod(false).lod({ source: "structure" });
      await until(() => net.lodSource !== "none", "a LOD tree after the reconfigure", 30);
      expect(net.lodSource).toBe("main");
    } finally {
      net.destroy();
    }
  });

  it("a drag held across a move to the worker keeps following the cursor in shared-memory mode", async () => {
    const host = makeHost();
    const net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const g = clustered(600);
      net.data(g).style({ nodeRadius: 6 }).interactive({ draggable: true }).layout({ backend: "gpu", iterations: 40 });
      await net.whenSettled();
      net.setTransform({ k: 1, x: W / 2 - (g.positions[0] ?? 0), y: H / 2 - (g.positions[1] ?? 0) });
      const hit = net.pick(W / 2, H / 2);
      const id = typeof hit?.id === "number" ? hit.id : -1;
      expect(id, "no node under the cursor to grab").toBeGreaterThanOrEqual(0);
      const x0 = g.positions[id * 2] ?? 0;
      const y0 = g.positions[id * 2 + 1] ?? 0;
      pointer(host, "pointerdown", W / 2, H / 2);
      pointer(host, "pointermove", W / 2 + 30, H / 2 + 10); // past the click slop: the drag starts
      expect(g.positions[id * 2]).toBeCloseTo(x0 + 30, 3);

      // The test page is not cross-origin isolated, so an ArrayBuffer stands in for the SharedArrayBuffer.
      // That drives the main thread's shared-memory path: the worker start replaces `graph.positions` with a
      // view of the shared buffer, and a pin carries ids only, the held positions being in that buffer.
      vi.stubGlobal("crossOriginIsolated", true);
      vi.stubGlobal("SharedArrayBuffer", ArrayBuffer);
      const posted = workerPosts();
      const before = g.positions;
      net.setBackend("canvas");
      await net.whenReady();
      await until(() => startOf(posted) !== undefined, "the idle worker start");
      expect(net.layoutTransport).toBe("shared");
      expect(g.positions, "the worker start swapped in the shared positions").not.toBe(before);

      pointer(host, "pointermove", W / 2 + 90, H / 2 + 40);
      expect(g.positions[id * 2], "the held node follows the cursor after the move").toBeCloseTo(x0 + 90, 3);
      expect(g.positions[id * 2 + 1]).toBeCloseTo(y0 + 40, 3);
      pointer(host, "pointerup", W / 2 + 90, H / 2 + 40);
    } finally {
      vi.unstubAllGlobals();
      net.destroy();
    }
  });
});

/** A network whose `"auto"` upgrade takes the WebGL backend in {@link upgradeWith}, made beforehand. */
class PrebuiltUpgradeNetwork extends Network {
  upgradeWith: Promise<BackendHandle> | null = null;
  protected override createWebGLBackend(): Promise<BackendHandle> {
    return this.upgradeWith ?? super.createWebGLBackend();
  }
}

/** One pointer event at host-relative (x, y), bubbling to the window listeners a node drag adds. */
function pointer(host: HTMLElement, type: string, x: number, y: number): void {
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
