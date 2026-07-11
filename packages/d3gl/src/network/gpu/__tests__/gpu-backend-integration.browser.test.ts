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

import { describe, it, expect, afterEach } from "vitest";
import { network } from "../../network.js";

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
});

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
  it("fit:true frames a ragged module layout — bulk of nodes inside the viewport at a healthy fill", async () => {
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
    net.layout({ backend: "gpu", fit: true, iterations: 200 });
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
