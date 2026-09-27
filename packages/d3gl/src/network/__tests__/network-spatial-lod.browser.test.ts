import { describe, it, expect } from "vitest";
import { network, type Network, type NetworkHit } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { HoverHit } from "../../map/base-engine.js";

/**
 * `lod({ source: "spatial" })` (#343) through the engine: the worker rebuilds a Morton tree per streamed
 * frame and the engine adopts it; the main-thread backends rebuild it when positions change; a selected
 * aggregate is carried over to the same cell across rebuilds; the Canvas (retained Scene) path draws the
 * same frontier and links.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Communities joined by random long-range links — a force layout spreads each community out. */
function webLike(n: number, seed = 5): NetworkGraph {
  const r = rng(seed);
  const src: number[] = [];
  const tgt: number[] = [];
  const size = 40;
  for (let i = 1; i < n; i++) {
    const base = i - (i % size);
    src.push(i); tgt.push(base + Math.floor(r() * (i - base)));
    if (r() < 0.6) { src.push(i); tgt.push(Math.floor(r() * n)); }
  }
  return buildGraph({ nodeCount: n, source: src, target: tgt });
}

/** A static spread of positions (no layout needed). */
function spread(n: number, seed = 3): Float32Array {
  const r = rng(seed);
  const pos = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 180;
    pos[2 * i] = 200 + Math.cos(a) * d;
    pos[2 * i + 1] = 200 + Math.sin(a) * d;
  }
  return pos;
}

function makeNet(backend?: "canvas"): { net: Network; host: HTMLDivElement } {
  const host = document.createElement("div");
  host.style.width = "400px";
  host.style.height = "400px";
  document.body.appendChild(host);
  const net = network(host, backend ? { width: 400, height: 400, backend } : { width: 400, height: 400 });
  return { net, host };
}

/** Hover a grid of screen points until the pointer is over an aggregate glyph; its hit, or null. */
function findAggregate(net: Network, host: HTMLDivElement): HoverHit | null {
  let found: HoverHit | null = null;
  net.on("hover", (hit) => {
    const d = hit?.datum as NetworkHit | undefined;
    if (!found && hit && d && "aggregate" in d && d.aggregate && d.count > 2) found = hit;
  });
  const rect = host.getBoundingClientRect();
  for (let y = 20; y < 380 && !found; y += 7) {
    for (let x = 20; x < 380 && !found; x += 7) {
      host.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, pointerId: 1 }));
    }
  }
  net.on("hover", null);
  return found;
}

/** Centroid of the members' current positions. */
function centroid(g: NetworkGraph, members: readonly (string | number)[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const m of members) {
    const i = Number(m);
    x += g.positions[2 * i]!;
    y += g.positions[2 * i + 1]!;
  }
  return [x / members.length, y / members.length];
}

describe("lod({ source: 'spatial' }) (#343)", () => {
  it("adopts the worker's per-frame spatial tree, keeps the frontier bounded, and answers a held view from the row memo", async () => {
    const { net, host } = makeNet();
    await net.whenReady();
    const g = webLike(6000);
    net.data(g).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "worker", iterations: 80, fit: true });
    await net.whenSettled();
    expect(net.lodSource).toBe("worker"); // the worker's tree: no main-thread build or geometry pass
    const glyphs = net.declutterStats?.glyphs ?? Infinity;
    expect(glyphs).toBeGreaterThan(0);
    expect(glyphs).toBeLessThan(1500); // bounded by the screen, not by how the layout spreads the graph

    // Links are gathered lazily; a held view re-emits them from the row memo without walking an edge.
    const first = net.superEdgeStats;
    expect(first).not.toBeNull();
    net.setTransform({ k: 2, x: -100, y: -100 });
    net.setTransform({ k: 2, x: -100, y: -100 });
    const held = net.superEdgeStats;
    expect(held?.misses).toBe(0);
    expect(held?.visits).toBe(0);
    expect(held?.hits).toBeGreaterThan(0);

    // Switching source after the run: the structural tree is built here; back to spatial re-adopts the worker's.
    net.lod({ source: "structure", maxAggregateRadius: 18 });
    await Promise.resolve();
    await Promise.resolve();
    expect(["main", "none"]).toContain(net.lodSource);
    net.lod({ source: "spatial", maxAggregateRadius: 18 });
    expect(net.lodSource).toBe("worker");
    net.destroy();
    host.remove();
  });

  it("carries a selected aggregate over to the same cell while the worker rebuilds the tree", async () => {
    const { net, host } = makeNet();
    await net.whenReady();
    const g = webLike(12000, 9);
    net.interactive({ selectable: true, hover: true });
    net.data(g).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "worker", iterations: 300 });
    // Wait for the first streamed tree, then select an aggregate while the layout still streams.
    for (let i = 0; i < 200 && net.lodSource !== "worker"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(net.lodSource).toBe("worker");
    let hit = findAggregate(net, host);
    for (let i = 0; i < 20 && !hit; i++) {
      await new Promise((r) => setTimeout(r, 20)); // the next streamed frame may frame it better
      hit = findAggregate(net, host);
    }
    expect(hit).not.toBeNull();
    if (!hit) return;
    net.select("nodes", [hit.id]);
    const before = net.selection()[0]!;
    const members0 = before.members?.() ?? [];
    expect(members0.length).toBeGreaterThan(2);
    const c0 = centroid(g, members0);
    let spanX = 0;
    let spanY = 0;
    for (const m of members0) {
      spanX = Math.max(spanX, Math.abs(g.positions[2 * Number(m)]! - c0[0]));
      spanY = Math.max(spanY, Math.abs(g.positions[2 * Number(m)]! - c0[1]));
    }
    await net.whenSettled();
    const after = net.selection();
    // The cell may have emptied as the layout moved nodes (then it is dropped); if kept, it is the same place.
    if (after.length > 0) {
      expect(after.length).toBe(1);
      const d = after[0]!.datum as NetworkHit;
      const members1 = after[0]!.members?.() ?? [];
      expect(members1.length).toBe("count" in d ? d.count : -1);
      const c1 = centroid(g, members1);
      const tol = 4 * Math.max(spanX, spanY, 1);
      expect(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])).toBeLessThan(tol + 50);
    }
    net.destroy();
    host.remove();
  });

  it("rebuilds on the main thread when positions change, remapping a selected aggregate to its cell", async () => {
    const { net, host } = makeNet();
    await net.whenReady();
    const n = 4000;
    const g = webLike(n, 2);
    const pos = spread(n);
    net.interactive({ selectable: true, hover: true });
    net.data(g).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "positions", positions: pos });
    net.setTransform({ k: 1, x: 0, y: 0 });
    expect(net.lodSource).toBe("spatial");
    const hit = findAggregate(net, host);
    expect(hit).not.toBeNull();
    if (!hit) return;
    net.select("nodes", [hit.id]);
    const members0 = [...(net.selection()[0]!.members?.() ?? [])].map(Number).sort((a, b) => a - b);
    // Nudge every node well inside its cell: the rebuilt tree has new ids, but the same cells.
    const nudged = pos.map((v) => v + 1e-3);
    net.layout({ backend: "positions", positions: nudged });
    const sel = net.selection();
    expect(sel.length).toBe(1);
    const members1 = [...(sel[0]!.members?.() ?? [])].map(Number).sort((a, b) => a - b);
    expect(members1).toEqual(members0);
    net.destroy();
    host.remove();
  });

  it("draws the spatial frontier and its lazily gathered links on the Canvas backend too", async () => {
    const { net, host } = makeNet("canvas");
    await net.whenReady();
    const n = 3000;
    const g = webLike(n, 4);
    net.data(g).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "positions", positions: spread(n) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    const svg = net.toSVG();
    const circles = (svg.match(/<circle/g) ?? []).length;
    expect(circles).toBeGreaterThan(0);
    expect(circles).toBeLessThan(n / 2);
    expect(svg).toMatch(/<path|<line/);
    expect(net.superEdgeStats).not.toBeNull();
    net.destroy();
    host.remove();
  });
});
