import { describe, it, expect, vi } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import type { InstancedLayer } from "../../core/backend.js";

/**
 * Per-frame regression test for the in-place position-update path (#179).
 *
 * Two regressions this guards, both on the no-LOD full-graph layout-repaint path:
 *
 * 1. GPU teardown per frame. Before this fix, every layout-repaint frame called
 *    `setInstancedLayer` (destroy+recreate) for the lines/arrows/half-arrows layers.
 *    Now `updateInstancedLayer` takes the in-place `bufferSubData` path — the JS renderer
 *    objects stay the SAME reference across N position-only frames (0 recreations).
 *
 * 2. Style-accessor re-derivation per frame. `networkLayers` re-ran the colour/width scale
 *    accessors O(edges) times EVERY frame (~600k `colorOf`/`widthOf` calls per frame at scale).
 *    Now the style-derived attributes are cached per resolved-style version; a position-only
 *    frame recomputes ONLY the position-derived endpoints. So the accessors run O(edges) ONCE
 *    at data/style registration, NOT per position frame — the signature AGENTS.md §5 mandates.
 */

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "300px";
  el.style.height = "300px";
  document.body.appendChild(el);
  return el;
}

/** Build a ring graph of `n` nodes for a predictable, spatially spread layout. */
function ringGraph(n: number) {
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
    weight.push(1 + (i % 5)); // varied weights so colour/width accessors get distinct inputs
  }
  return buildGraph({ nodeCount: n, source, target, weight, directed: false });
}

/** Ring positions: nodes spread around a circle of radius `r`, centered at (cx, cy). */
function ringPositions(n: number, cx = 150, cy = 150, r = 120): Float32Array {
  const pos = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pos[2 * i] = cx + r * Math.cos(a);
    pos[2 * i + 1] = cy + r * Math.sin(a);
  }
  return pos;
}

/** Mutate a graph's position buffer IN PLACE (as a force layout tick does), then trigger a repaint. */
function tickPositions(net: object, n: number, frame: number): void {
  const graph = (net as { graph: { positions: Float32Array } }).graph;
  const p = graph.positions;
  for (let i = 0; i < n; i++) {
    p[2 * i] = p[2 * i]! + Math.cos(i + frame) * 1.0;
    p[2 * i + 1] = p[2 * i + 1]! + Math.sin(i + frame) * 1.0;
  }
  // Drive the real per-tick repaint path (scheduleLayoutRepaint → rebuild), synchronously here.
  (net as { rebuild(): void }).rebuild();
}

describe("network instanced lane — in-place position update (#179 regression guard)", () => {
  it("does NOT re-run the colour/width scale accessors per position frame (O(edges) ONCE, not per frame)", async () => {
    const N_NODES = 400;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);
    let colorCalls = 0;
    let widthCalls = 0;

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net
      .data(g)
      // Function accessors (d3-scale shape) so we can count invocations. weight → colour / width.
      .style({
        nodeRadius: 4,
        linkStroke: (w: number) => { colorCalls++; return w % 2 ? "#3b82f6" : "#ef4444"; },
        linkWidth: (w: number) => { widthCalls++; return 1 + w * 0.2; },
      })
      .layout({ backend: "positions", positions: pos });

    // After the first full emit, the accessors have each run ~O(edges) once (the ring has N edges).
    const colorAfterInit = colorCalls;
    const widthAfterInit = widthCalls;
    expect(colorAfterInit).toBeGreaterThan(0);
    expect(widthAfterInit).toBeGreaterThan(0);

    // Now N position-only frames (positions mutate; style unchanged).
    const N_FRAMES = 20;
    for (let frame = 0; frame < N_FRAMES; frame++) tickPositions(net, N_NODES, frame);

    // The accessors must NOT have run again — style attributes are cached across position frames.
    // Pre-fix: colorCalls ≈ colorAfterInit × (1 + N_FRAMES). Post-fix: exactly colorAfterInit.
    expect(colorCalls).toBe(colorAfterInit);
    expect(widthCalls).toBe(widthAfterInit);

    net.destroy();
  });

  it("uploads ONLY the endpoint buffers per position frame — colour/width buffers are NOT re-uploaded", async () => {
    const N_NODES = 300;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ nodeRadius: 4, linkStroke: (w: number) => (w % 2 ? "#3b82f6" : "#ef4444"), linkWidth: (w: number) => 1 + w * 0.2 }).layout({ backend: "positions", positions: pos });

    // Reach the links renderer's private GPU buffers and spy their `write` (bufferSubData) methods
    // AFTER the initial emit, so we count only per-position-frame uploads.
    const lines = (net as unknown as { handle: { backend: { instanced: Map<string, {
      source: { write(a: ArrayBufferView): void };
      target: { write(a: ArrayBufferView): void };
      widthBuf: { write(a: ArrayBufferView): void };
      color: { write(a: ArrayBufferView): void };
    }> } } }).handle.backend.instanced.get("links")!;
    const srcSpy = vi.spyOn(lines.source, "write");
    const tgtSpy = vi.spyOn(lines.target, "write");
    const widthSpy = vi.spyOn(lines.widthBuf, "write");
    const colorSpy = vi.spyOn(lines.color, "write");

    const N_FRAMES = 12;
    for (let frame = 0; frame < N_FRAMES; frame++) tickPositions(net, N_NODES, frame);

    // Endpoints upload every frame (freshly allocated each rebuild → new reference).
    expect(srcSpy.mock.calls.length).toBe(N_FRAMES);
    expect(tgtSpy.mock.calls.length).toBe(N_FRAMES);
    // Style-derived buffers are reference-stable across position frames → skipped (0 re-uploads).
    expect(widthSpy.mock.calls.length).toBe(0);
    expect(colorSpy.mock.calls.length).toBe(0);

    net.destroy();
  });

  it("a style() change DOES re-upload the colour buffer (reference-skip invariant holds both ways)", async () => {
    const N_NODES = 200;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ nodeRadius: 4, linkStroke: (w: number) => (w % 2 ? "#3b82f6" : "#ef4444"), linkWidth: 1 }).layout({ backend: "positions", positions: pos });

    const lines = (net as unknown as { handle: { backend: { instanced: Map<string, {
      color: { write(a: ArrayBufferView): void };
    }> } } }).handle.backend.instanced.get("links")!;
    const colorSpy = vi.spyOn(lines.color, "write");

    // Position frames — no colour re-upload.
    for (let frame = 0; frame < 6; frame++) tickPositions(net, N_NODES, frame);
    expect(colorSpy.mock.calls.length).toBe(0);

    // A style() change produces a FRESH colour array (new reference) → the buffer re-uploads.
    net.style({ linkStroke: (w: number) => (w % 2 ? "#22c55e" : "#a855f7") });
    expect(colorSpy.mock.calls.length).toBeGreaterThan(0); // colour buffer re-uploaded with the new colours

    net.destroy();
  });

  it("lines/arrows renderers are NOT destroyed+recreated per position frame (no-LOD, undirected)", async () => {
    const N_NODES = 500;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ nodeRadius: 4, linkWidth: 1 }).layout({ backend: "positions", positions: pos });

    const instanced: Map<string, object> = (net as unknown as {
      handle: { backend: { instanced: Map<string, object> } }
    }).handle.backend.instanced;

    const beforeLines = instanced.get("links");
    expect(beforeLines).toBeDefined();

    const N_FRAMES = 20;
    const backend = (net as unknown as { handle: { backend: { setInstancedLayer: (l: InstancedLayer) => void } } }).handle.backend;
    const setLayerSpy = vi.spyOn(backend, "setInstancedLayer");

    for (let frame = 0; frame < N_FRAMES; frame++) tickPositions(net, N_NODES, frame);

    // setInstancedLayer must NOT have been called for the links layer across position frames.
    const recreateCalls = setLayerSpy.mock.calls.filter(([l]) => l.name === "links" || l.name === "arrows");
    expect(recreateCalls.length).toBe(0);

    // The renderer object must be the SAME reference (not destroyed+recreated).
    expect(instanced.get("links")).toBe(beforeLines);

    net.destroy();
  });

  it("lines renderer is NOT destroyed+recreated per position frame (directed graph with arrows)", async () => {
    const N_NODES = 300;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ directed: true, nodeRadius: 4, linkWidth: 1 }).layout({ backend: "positions", positions: pos });

    const instanced: Map<string, object> = (net as unknown as {
      handle: { backend: { instanced: Map<string, object> } }
    }).handle.backend.instanced;

    const beforeLines = instanced.get("links");
    const beforeArrows = instanced.get("arrows");
    expect(beforeLines).toBeDefined();

    const N_FRAMES = 15;
    const backend = (net as unknown as { handle: { backend: { setInstancedLayer: (l: InstancedLayer) => void } } }).handle.backend;
    const setLayerSpy = vi.spyOn(backend, "setInstancedLayer");

    for (let frame = 0; frame < N_FRAMES; frame++) tickPositions(net, N_NODES, frame);

    const recreateCalls = setLayerSpy.mock.calls.filter(([l]) =>
      l.name === "links" || l.name === "arrows" || l.name === "half-arrows"
    );
    expect(recreateCalls.length).toBe(0);

    expect(instanced.get("links")).toBe(beforeLines);
    if (beforeArrows !== undefined) expect(instanced.get("arrows")).toBe(beforeArrows);

    net.destroy();
  });

  it("style cache busts on a style() change AFTER layout frames (new colours re-derive)", async () => {
    const N_NODES = 200;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);
    let colorCalls = 0;

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net
      .data(g)
      .style({ nodeRadius: 4, linkStroke: (w: number) => { colorCalls++; return w % 2 ? "#3b82f6" : "#ef4444"; }, linkWidth: 1 })
      .layout({ backend: "positions", positions: pos });

    const afterInit = colorCalls;
    expect(afterInit).toBeGreaterThan(0);

    // Position frames — no re-derivation.
    for (let frame = 0; frame < 8; frame++) tickPositions(net, N_NODES, frame);
    expect(colorCalls).toBe(afterInit);

    // A style() change (different accessor) must bust the cache and re-derive.
    net.style({ linkStroke: (w: number) => { colorCalls++; return w % 2 ? "#22c55e" : "#a855f7"; } });
    expect(colorCalls).toBeGreaterThan(afterInit); // re-derived with the new accessor

    // The new colour reaches the GPU: the links renderer holds fresh colour bytes (same object, updated in place).
    const instanced = (net as unknown as { handle: { backend: { instanced: Map<string, { count: number }> } } }).handle.backend.instanced;
    expect(instanced.get("links")?.count).toBe(N_NODES); // ring has N edges

    net.destroy();
  });

  it("highlight group columns are NOT re-uploaded per position frame — selection leaves them alone, a style change re-uploads (#214)", async () => {
    const N_NODES = 300;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ nodeRadius: 4, linkStroke: "#3b82f6", linkWidth: 1 }).layout({ backend: "positions", positions: pos });
    net.interactive({ selectable: true });

    // Reach the renderers' #162 highlight buffers and spy their `write` (bufferSubData) methods
    // AFTER the initial emit, so we count only per-position-frame uploads.
    type Writable = { write(a: ArrayBufferView): void };
    type WithHl = { hl: { group: Writable; group2: Writable; selected: Writable }; source: Writable };
    const instanced = (net as unknown as { handle: { backend: { instanced: Map<string, WithHl> } } }).handle.backend.instanced;
    const lines = instanced.get("links")!;
    const nodes = instanced.get("nodes")!;
    const srcSpy = vi.spyOn(lines.source, "write");
    const groupSpy = vi.spyOn(lines.hl.group, "write");
    const group2Spy = vi.spyOn(lines.hl.group2, "write");
    const nodeGroupSpy = vi.spyOn(nodes.hl.group, "write");
    const selSpy = vi.spyOn(lines.hl.selected, "write");

    // N position-only frames: endpoints upload every frame, but the #162 group columns come from the
    // #179/#214 cache — the SAME array instances — so their upload is reference-skipped (0 re-uploads).
    const N_FRAMES = 12;
    for (let frame = 0; frame < N_FRAMES; frame++) tickPositions(net, N_NODES, frame);
    expect(srcSpy.mock.calls.length).toBe(N_FRAMES); // sanity: the frames really emitted
    expect(groupSpy.mock.calls.length).toBe(0); // per-edge source ids: cached, never re-uploaded
    expect(group2Spy.mock.calls.length).toBe(0); // per-edge target ids (undirected): cached too
    expect(nodeGroupSpy.mock.calls.length).toBe(0); // node identity column: cached too

    // A selection change refreshes ONLY the selected flags (in place, via the #162 restyle path) —
    // the group columns stay untouched, and later position frames still skip their upload.
    const selBefore = selSpy.mock.calls.length;
    net.select("nodes", [1]);
    expect(selSpy.mock.calls.length).toBeGreaterThan(selBefore); // flag buffer rewritten in place
    for (let frame = 0; frame < 4; frame++) tickPositions(net, N_NODES, frame);
    expect(groupSpy.mock.calls.length).toBe(0);
    expect(group2Spy.mock.calls.length).toBe(0);

    // A style() change busts the cache → fresh column instances → the group buffers DO re-upload
    // (the reference-skip invariant holds in both directions).
    net.style({ linkStroke: "#22c55e" });
    expect(groupSpy.mock.calls.length).toBeGreaterThan(0);

    net.destroy();
  });

  it("selected flags are NOT re-uploaded per position frame — a selection change refreshes in place, a fresh registration re-seeds (#240)", async () => {
    const N_NODES = 300;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ nodeRadius: 4, linkStroke: "#3b82f6", linkWidth: 1 }).layout({ backend: "positions", positions: pos });
    net.interactive({ selectable: true });
    net.select("nodes", [1]); // an ACTIVE selection during the frames — the flags are non-trivial

    // Spy the #162 `a_selected` buffer writes (bufferSubData) AFTER the initial emit + selection, so we
    // count only per-position-frame uploads. (The #214 test above covers the group columns.)
    type Writable = { write(a: ArrayBufferView): void };
    type WithHl = { hl: { selected: Writable }; source: Writable };
    const instanced = (net as unknown as { handle: { backend: { instanced: Map<string, WithHl> } } }).handle.backend.instanced;
    const lines = instanced.get("links")!;
    const nodes = instanced.get("nodes")!;
    const srcSpy = vi.spyOn(lines.source, "write");
    const lineSelSpy = vi.spyOn(lines.hl.selected, "write");
    const nodeSelSpy = vi.spyOn(nodes.hl.selected, "write");

    // N position-only frames with an UNCHANGED selection: the flag columns come from the #240
    // selection-versioned cache — the SAME array instances — so their O(nodes)+O(edges) float
    // conversion + upload is reference-skipped (0 re-uploads; pre-fix: one per layer per frame).
    const N_FRAMES = 12;
    for (let frame = 0; frame < N_FRAMES; frame++) tickPositions(net, N_NODES, frame);
    expect(srcSpy.mock.calls.length).toBe(N_FRAMES); // sanity: the frames really emitted
    expect(lineSelSpy.mock.calls.length).toBe(0); // per-edge selected flags: cached, never re-uploaded
    expect(nodeSelSpy.mock.calls.length).toBe(0); // per-node selected flags: cached too

    // A selection change refreshes the flags in place (writeSelected) — exactly then, not per frame:
    // the fresh arrays it uploads are the ones later emits hand back, so the skip resumes immediately.
    net.select("nodes", [2]);
    const lineAfterSel = lineSelSpy.mock.calls.length;
    const nodeAfterSel = nodeSelSpy.mock.calls.length;
    expect(lineAfterSel).toBeGreaterThan(0); // flag buffer rewritten in place on the change
    expect(nodeAfterSel).toBeGreaterThan(0);
    for (let frame = 0; frame < 4; frame++) tickPositions(net, N_NODES, frame);
    expect(lineSelSpy.mock.calls.length).toBe(lineAfterSel); // position frames skip again
    expect(nodeSelSpy.mock.calls.length).toBe(nodeAfterSel);

    // Fresh layer registration (backend recreates the link primitives — a backend/pick-model switch):
    // the new buffer is seeded with the CURRENT flags at creation, position frames skip on it too, and
    // the next selection change's first write still uploads (no stale skip on a fresh buffer).
    net.pickLinks(true); // pick-model mismatch forces setInstancedLayer → fresh HighlightBuffers
    const lines2 = instanced.get("links")!;
    expect(lines2).not.toBe(lines); // really a fresh renderer object
    const lineSelSpy2 = vi.spyOn(lines2.hl.selected, "write");
    for (let frame = 0; frame < 4; frame++) tickPositions(net, N_NODES, frame);
    expect(lineSelSpy2.mock.calls.length).toBe(0); // constructor seeded the flags — emits skip
    net.select("nodes", [1]);
    expect(lineSelSpy2.mock.calls.length).toBeGreaterThan(0); // first write after registration uploads

    net.destroy();
  });

  it("a genuine data() change fully rebuilds (new topology reaches the GPU)", async () => {
    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();

    const g1 = ringGraph(100);
    net.data(g1).style({ nodeRadius: 4, linkWidth: 1 }).layout({ backend: "positions", positions: ringPositions(100) });
    const instanced = (net as unknown as { handle: { backend: { instanced: Map<string, { count: number }> } } }).handle.backend.instanced;
    expect(instanced.get("links")?.count).toBe(100); // 100 ring edges

    // A different graph — full rebuild; the link count tracks the new topology.
    const g2 = ringGraph(250);
    net.data(g2).layout({ backend: "positions", positions: ringPositions(250) });
    expect(instanced.get("links")?.count).toBe(250);

    net.destroy();
  });

  it("position frame throughput — N frames of in-place update complete well within budget", async () => {
    const N_NODES = 1000;
    const N_EDGES = N_NODES; // ring: exactly N edges
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ nodeRadius: 3, linkWidth: 1 }).layout({ backend: "positions", positions: pos });

    const N_FRAMES = 20;
    const t0 = performance.now();
    for (let frame = 0; frame < N_FRAMES; frame++) tickPositions(net, N_NODES, frame);
    const elapsed = performance.now() - t0;

    // Budget: 1000ms / 20 frames = 50ms/frame ceiling on SwiftShader (5-10× headroom over expected).
    const BUDGET_MS = 1000;
    expect(elapsed).toBeLessThan(BUDGET_MS);

    const instanced: Map<string, object> = (net as unknown as {
      handle: { backend: { instanced: Map<string, object> } }
    }).handle.backend.instanced;
    expect(instanced.has("links")).toBe(true);
    const linesRenderer = instanced.get("links") as { count: number } | undefined;
    expect(linesRenderer?.count).toBe(N_EDGES);

    net.destroy();
  });
});
