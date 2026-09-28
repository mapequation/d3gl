import { describe, it, expect } from "vitest";
import { network, type Network, type NetworkHit } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { HoverHit } from "../../map/base-engine.js";
import { lodStylePasses, mortonTopologyBuilds } from "../lod.js";
import { spatialRowBuilds } from "../spatial-rows.js";

/**
 * `lod({ source: "spatial" })` (#343) through the engine: the worker rebuilds a Morton tree per streamed
 * frame — with its super-edge rows, so a streamed repaint gathers links without walking a leaf run (#433) —
 * and the engine adopts it; the main-thread backends rebuild it when positions change; a selected
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
  it("adopts the worker's per-frame spatial tree, keeps the frontier bounded, and gathers its links from the worker's rows", async () => {
    const { net, host } = makeNet();
    await net.whenReady();
    const g = webLike(6000);
    net.data(g).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "worker", iterations: 80, fit: true });
    await net.whenSettled();
    expect(net.lodSource).toBe("worker"); // the worker's tree: no main-thread build or geometry pass
    const glyphs = net.declutterStats?.glyphs ?? Infinity;
    expect(glyphs).toBeGreaterThan(0);
    expect(glyphs).toBeLessThan(1500); // bounded by the screen, not by how the layout spreads the graph

    // Links come from the super-edge rows the worker built with the tree (#433): no leaf run is walked, at a
    // new view or a held one.
    const first = net.superEdgeStats;
    expect(first).not.toBeNull();
    net.setTransform({ k: 2, x: -100, y: -100 });
    net.setTransform({ k: 2, x: -100, y: -100 });
    const held = net.superEdgeStats;
    expect(held?.misses).toBe(0);
    expect(held?.visits).toBe(0);
    expect(held?.entries).toBeGreaterThan(0);

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

  // Per-frame guard (#433, AGENTS lifecycle §5): with the spatial source every streamed frame brings a new tree,
  // so the lazy gather's per-tree row memo never hits and each repaint walked every edge under the frontier —
  // O(edges) on the main thread (2E incidences at a fit view). The worker now builds the tree's super-edge rows
  // with it; the repaint reads O(rows of the drawn and culled covers) and walks no leaf run. The deterministic
  // signature, on every animation frame that drew a worker tree: zero incidences walked, rows read, and no row
  // build in this realm (the worker's builds never touch its counter).
  it("streamed repaints gather links from the worker's rows: no leaf-run walk and no main-thread row build per frame", async () => {
    const { net, host } = makeNet();
    const installed = window.requestAnimationFrame;
    try {
      await net.whenReady();
      const g = webLike(20_000);
      // Every animation frame drawn while the layout streams (the settle reframes to the exact box, a view
      // the last streamed tree's rows were not cut for: its missing rows are summed once, then kept).
      let settled = false;
      const samples: { visits: number; entries: number; misses: number }[] = [];
      window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
        installed.call(window, (t: number) => {
          callback(t);
          const stats = net.superEdgeStats;
          if (!settled && stats && net.lodSource === "worker") samples.push({ visits: stats.visits, entries: stats.entries, misses: stats.misses });
        });
      const builds0 = spatialRowBuilds;
      net.data(g).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "worker", iterations: 60, fit: true });
      await net.whenSettled().then(() => { settled = true; });
      expect(samples.length, "no repaint drew a worker tree").toBeGreaterThan(3);
      for (const [i, s] of samples.entries()) {
        expect(s.visits, `streamed repaint ${i} of ${samples.length} walked leaf runs`).toBe(0);
        expect(s.misses).toBe(0);
        expect(s.entries).toBeGreaterThan(0);
      }
      expect(spatialRowBuilds - builds0, "rows built on the main thread").toBe(0);
      // Every edge under the frontier is what the lazy gather would have walked: the rows read are far fewer.
      expect(Math.max(...samples.map((s) => s.entries))).toBeLessThan(g.csr.neighbors.length);
    } finally {
      window.requestAnimationFrame = installed;
      net.destroy();
      host.remove();
    }
  }, 60_000);

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

  it("carries a selected aggregate over when a worker-streamed spatial tree gives way to a main-thread one", async () => {
    const { net, host } = makeNet();
    await net.whenReady();
    const n = 6000;
    const g = webLike(n, 6);
    net.interactive({ selectable: true, hover: true });
    net.data(g).style({ sizeMode: "screen", nodeRadius: 3 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "worker", iterations: 60, fit: true });
    await net.whenSettled();
    expect(net.lodSource).toBe("worker");
    const hit = findAggregate(net, host);
    expect(hit).not.toBeNull();
    if (!hit) return;
    net.select("nodes", [hit.id]);
    const members0 = new Set((net.selection()[0]!.members?.() ?? []).map(Number));
    expect(members0.size).toBeGreaterThan(2);
    // The layout handed back as caller positions, with the far half of it collapsed onto one point (the
    // extreme nodes stay, so the extent does too): the main thread rebuilds the spatial tree with far fewer
    // cells, so the ids after them shift, while the selected cell's own members stay where they were. (A
    // fresh root box may re-express the cell on a coarser or finer grid — the carried-over glyph's members
    // then contain, or are contained in, the selected ones.)
    const pos = g.positions.slice();
    const [cx0, cy0] = centroid(g, [...members0]);
    const extremes = new Set<number>();
    let far = 0;
    let span = 0;
    for (const pick of [(i: number) => pos[2 * i]!, (i: number) => -pos[2 * i]!, (i: number) => pos[2 * i + 1]!, (i: number) => -pos[2 * i + 1]!]) {
      let best = 0;
      for (let i = 1; i < n; i++) if (pick(i) > pick(best)) best = i;
      extremes.add(best);
    }
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(pos[2 * i]! - cx0, pos[2 * i + 1]! - cy0);
      if (d > span) { span = d; far = i; }
    }
    for (let i = 0; i < n; i++) {
      if (members0.has(i) || extremes.has(i) || Math.hypot(pos[2 * i]! - cx0, pos[2 * i + 1]! - cy0) < span / 2) continue;
      pos[2 * i] = pos[2 * far]!;
      pos[2 * i + 1] = pos[2 * far + 1]!;
    }
    net.layout({ backend: "positions", positions: pos });
    expect(net.lodSource).toBe("spatial");
    const sel = net.selection();
    expect(sel.length).toBe(1);
    const members1 = new Set((sel[0]!.members?.() ?? []).map(Number));
    const inner = members1.size <= members0.size ? members1 : members0;
    const outer = inner === members1 ? members0 : members1;
    for (const m of inner) expect(outer.has(m), `member ${m} of the carried-over cell`).toBe(true);
    // At most a level apart (a quarter or four times the area), not an unrelated ancestor holding both.
    expect(outer.size, `carried over to a cell of ${members1.size} nodes from one of ${members0.size}`).toBeLessThanOrEqual(8 * inner.size);
    net.destroy();
    host.remove();
  });

  it("a force drag refits the spatial tree per frame and rebuilds it once the nodes come to rest", async () => {
    const realRaf = globalThis.requestAnimationFrame;
    const realCaf = globalThis.cancelAnimationFrame;
    const queue = new Map<number, FrameRequestCallback>();
    let id = 0;
    const step = (frames: number): void => {
      for (let f = 0; f < frames; f++) {
        const due = [...queue.values()];
        queue.clear();
        for (const cb of due) cb(performance.now());
      }
    };
    const { net, host } = makeNet();
    try {
      await net.whenReady();
      const n = 3000;
      const g = webLike(n, 8);
      net.data(g).style({ sizeMode: "screen", nodeRadius: 6 }).lod({ source: "spatial", maxAggregateRadius: 18 }).layout({ backend: "force", iterations: 30 });
      // Node 0 at the centre of the view: grab whatever glyph sits over it.
      net.setTransform({ k: 1, x: 200 - g.positions[0]!, y: 200 - g.positions[1]! });
      net.interactive({ draggable: true });
      expect(net.lodSource).toBe("spatial");
      globalThis.requestAnimationFrame = (cb) => { queue.set(++id, cb); return id; };
      globalThis.cancelAnimationFrame = (i) => void queue.delete(i);
      const r = host.getBoundingClientRect();
      const [x0, y0] = [200, 200];
      const ev = (type: string, x: number, y: number): boolean =>
        (type === "pointerdown" ? host : window).dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
      ev("pointerdown", x0, y0);
      ev("pointermove", x0 + 25, y0 + 15);
      const builds0 = mortonTopologyBuilds;
      const styles0 = lodStylePasses;
      const before = [g.positions[4]!, g.positions[5]!];
      step(20);
      expect(g.positions[4] !== before[0] || g.positions[5] !== before[1], "the drag's reheat never ticked the layout").toBe(true);
      expect(mortonTopologyBuilds - builds0, "spatial trees built during the drag frames").toBe(0);
      expect(lodStylePasses - styles0, "style passes during the drag frames").toBe(0);
      // Release: the cool-down tail still only refits; its last frame rebuilds the tree once.
      ev("pointerup", x0 + 25, y0 + 15);
      step(95);
      expect(queue.size, "the force drag's rAF loop did not stop after its tail").toBe(0);
      expect(mortonTopologyBuilds - builds0, "one rebuild once the nodes came to rest").toBe(1);
      expect(lodStylePasses - styles0).toBe(1);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCaf;
      net.destroy();
      host.remove();
    }
  });

  it("keeps a main-thread spatial tree following a settled worker's reheat after a source switch", async () => {
    const { net, host } = makeNet();
    try {
      await net.whenReady();
      const n = 3000;
      const g = webLike(n, 10);
      // The worker streams the coarsening tree; the source switches to spatial once it has settled.
      net.data(g).style({ sizeMode: "screen", nodeRadius: 6 }).lod({ maxAggregateRadius: 18 }).layout({ backend: "worker", iterations: 40 });
      await net.whenSettled();
      net.lod({ source: "spatial", maxAggregateRadius: 18 });
      for (let i = 0; i < 100 && net.lodSource !== "spatial"; i++) await new Promise((r) => setTimeout(r, 10));
      expect(net.lodSource).toBe("spatial"); // built on the main thread: the worker streams the other kind
      net.setTransform({ k: 1, x: 200 - g.positions[0]!, y: 200 - g.positions[1]! });
      net.interactive({ draggable: true });
      // Hold a node: the worker reheats and streams frames; each moves every node, so the tree is rebuilt.
      const builds0 = mortonTopologyBuilds;
      const r = host.getBoundingClientRect();
      host.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 200, clientY: r.top + 200, bubbles: true, button: 0, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 230, clientY: r.top + 215, bubbles: true, button: 0, pointerId: 1 }));
      for (let i = 0; i < 200 && mortonTopologyBuilds === builds0; i++) await new Promise((res) => setTimeout(res, 10));
      expect(mortonTopologyBuilds, "the spatial tree was never rebuilt during the worker's reheat").toBeGreaterThan(builds0);
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left + 230, clientY: r.top + 215, bubbles: true, button: 0, pointerId: 1 }));
    } finally {
      net.destroy();
      host.remove();
    }
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
