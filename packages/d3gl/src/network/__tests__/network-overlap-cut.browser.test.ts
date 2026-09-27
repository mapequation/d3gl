import { describe, it, expect } from "vitest";
import { network, type Network, type NetworkLODOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleNode } from "../modules.js";

/**
 * #426 through the engine: with LOD on, a graph whose glyphs do not overlap at the fit view draws every
 * node as a leaf — on every tree kind (spatial, structure, modules) and on the main-thread and worker
 * paths — while the same nodes packed into overlapping clumps still aggregate. `declutterStats.glyphs` is
 * the cut before declutter, so it equals the node count exactly when the cut drew no aggregate.
 */

const SIZE = 400;
const RADIUS = 2;

function makeNet(): { net: Network; host: HTMLDivElement } {
  const host = document.createElement("div");
  host.style.width = `${SIZE}px`;
  host.style.height = `${SIZE}px`;
  document.body.appendChild(host);
  return { net: network(host, { width: SIZE, height: SIZE }), host };
}

/** A ring (so the coarsening tree has edges to match) of `n` nodes. */
function ring(n: number): NetworkGraph {
  const source = Array.from({ length: n }, (_, i) => i);
  const target = Array.from({ length: n }, (_, i) => (i + 1) % n);
  return buildGraph({ nodeCount: n, source, target });
}

/** `side × side` lattice positions, `pitch` apart. */
function lattice(side: number, pitch: number): Float32Array {
  const pos = new Float32Array(2 * side * side);
  for (let i = 0; i < side * side; i++) {
    pos[2 * i] = (i % side) * pitch;
    pos[2 * i + 1] = Math.floor(i / side) * pitch;
  }
  return pos;
}

/** The transform that frames the positions' box into 85% of the view. */
function frame(pos: Float32Array): { k: number; x: number; y: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pos.length; i += 2) {
    const x = pos[i] ?? 0, y = pos[i + 1] ?? 0;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const k = (0.85 * SIZE) / Math.max(x1 - x0, y1 - y0, 1e-6);
  return { k, x: SIZE / 2 - (k * (x0 + x1)) / 2, y: SIZE / 2 - (k * (y0 + y1)) / 2 };
}

/** Pairs of glyphs (screen radius `RADIUS`) that overlap at zoom `k`. */
function overlaps(pos: Float32Array, k: number): number {
  let n = 0;
  for (let i = 0; i < pos.length; i += 2) {
    for (let j = i + 2; j < pos.length; j += 2) {
      if (Math.hypot((pos[i] ?? 0) - (pos[j] ?? 0), (pos[i + 1] ?? 0) - (pos[j + 1] ?? 0)) * k < 2 * RADIUS) n++;
    }
  }
  return n;
}

/** One module per `w × h` patch of a `side × side` lattice. */
function patches(side: number, w: number, h: number): ModuleNode[] {
  const per = Math.ceil(side / w);
  const rank = new Map<number, number>();
  return Array.from({ length: side * side }, (_, id) => {
    const m = Math.floor(Math.floor(id / side) / h) * per + Math.floor((id % side) / w);
    const r = (rank.get(m) ?? 0) + 1;
    rank.set(m, r);
    return { id, path: [m + 1, r] };
  });
}

describe("LOD aggregates only where glyphs would overlap (#426)", () => {
  const SIDE = 24; // 576 nodes, like the 552-node Navigator graph
  const cases: { name: string; lod: NetworkLODOptions; modules?: boolean }[] = [
    { name: "spatial", lod: { source: "spatial", maxAggregateRadius: 18 } },
    { name: "structure", lod: { source: "structure", maxAggregateRadius: 18 } },
    { name: "modules", lod: { maxAggregateRadius: 18 }, modules: true },
  ];
  for (const c of cases) {
    it(`a spread graph opens to every leaf at the fit view, a clumped one stays aggregated (${c.name}, main thread)`, async () => {
      const { net, host } = makeNet();
      try {
        await net.whenReady();
        const g = ring(SIDE * SIDE);
        const spread = lattice(SIDE, 10);
        const modules = patches(SIDE, 6, 4);
        net.data(g, c.modules ? { modules } : undefined).style({ sizeMode: "screen", nodeRadius: RADIUS }).lod(c.lod);
        net.layout({ backend: "positions", positions: spread });
        const t = frame(spread);
        expect(overlaps(spread, t.k), "precondition: no two glyphs overlap at the fit view").toBe(0);
        net.setTransform(t);
        expect(net.declutterStats?.glyphs, "every node drawn as a leaf").toBe(g.nodeCount);

        // The same nodes in overlapping clumps, one per 6 × 4 patch (a module's members for the module tree):
        // aggregates return.
        const clumped = new Float32Array(spread.length);
        for (let i = 0; i < g.nodeCount; i++) {
          const m = (modules[i]?.path[0] ?? 1) - 1;
          clumped[2 * i] = (m % 6) * 60 + (spread[2 * i] ?? 0) * 0.02;
          clumped[2 * i + 1] = Math.floor(m / 6) * 60 + (spread[2 * i + 1] ?? 0) * 0.02;
        }
        net.layout({ backend: "positions", positions: clumped });
        net.setTransform(frame(clumped));
        expect(net.declutterStats?.glyphs ?? Infinity).toBeLessThan(g.nodeCount / 2);
      } finally {
        net.destroy();
        host.remove();
      }
    });
  }

  it("the worker's per-frame spatial tree carries the crowding: a spread layout opens to every leaf", async () => {
    const { net, host } = makeNet();
    try {
      await net.whenReady();
      const n = 300;
      const g = buildGraph({ nodeCount: n, source: [], target: [] }); // edge-less: repulsion spreads it evenly
      net.data(g).style({ sizeMode: "screen", nodeRadius: RADIUS }).lod({ source: "spatial", maxAggregateRadius: 18 });
      net.layout({ backend: "worker", iterations: 120 });
      await net.whenSettled();
      expect(net.lodSource).toBe("worker"); // the worker's tree and its crowding, no main-thread pass
      const t = frame(g.positions);
      expect(overlaps(g.positions, t.k), "precondition: no two glyphs overlap at the fit view").toBe(0);
      net.setTransform(t);
      expect(net.declutterStats?.glyphs).toBe(n);
    } finally {
      net.destroy();
      host.remove();
    }
  });

  it("a structure tree streamed by the worker opens to every leaf once the spread layout settles", async () => {
    const { net, host } = makeNet();
    try {
      await net.whenReady();
      const g = ring(300);
      net.data(g).style({ sizeMode: "screen", nodeRadius: RADIUS }).lod({ source: "structure", maxAggregateRadius: 18 });
      net.layout({ backend: "worker", iterations: 120 });
      await net.whenSettled();
      expect(net.lodSource).toBe("worker");
      const t = frame(g.positions);
      expect(overlaps(g.positions, t.k), "precondition: no two glyphs overlap at the fit view").toBe(0);
      net.setTransform(t);
      expect(net.declutterStats?.glyphs).toBe(300);
    } finally {
      net.destroy();
      host.remove();
    }
  });
});
