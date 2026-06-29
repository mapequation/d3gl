import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

// N7c-2: nodes/aggregates on the instanced lane gain managed selection + hover ring + members().
// The ring rendering rides the lane emit (exercised here — it must not throw); the observable
// contract (selection()/on("select")/members()/pick) is asserted directly.
describe("network interactive lane (#105 N7c-2)", () => {
  it("opt-in is required: select() is a no-op until interactive() is set", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) });

    net.select("nodes", [1]); // no interactive() → ignored
    expect(net.selection()).toEqual([]);
    net.destroy();
  });

  it("programmatic select + on('select') carry the datum and leaf members()", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) });
    net.interactive({ selectable: { multi: true }, hover: true });

    const fired: Array<Array<{ id: string | number; members: (string | number)[] | undefined }>> = [];
    net.on("select", (hits) => fired.push(hits.map((h) => ({ id: h.id, members: h.members?.() }))));

    net.select("nodes", [1]); // exercises the ring overlay emit (must not throw)
    const sel = net.selection();
    expect(sel.map((h) => h.id)).toEqual([1]);
    expect(sel[0]!.datum).toEqual({ aggregate: false, count: 1 });
    expect(sel[0]!.members?.()).toEqual([1]); // a leaf represents itself
    expect(fired.at(-1)).toEqual([{ id: 1, members: [1] }]);

    net.select("nodes", null); // clear
    expect(net.selection()).toEqual([]);
    net.destroy();
  });

  it("pick resolves a node hit carrying members()", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) });
    net.interactive({ selectable: true });

    const hit = net.pick(10, 10); // node 0 at world/screen (10,10)
    expect(hit?.layer).toBe("nodes");
    expect(hit?.id).toBe(0);
    expect(hit?.members?.()).toEqual([0]);
    net.destroy();
  });

  it("on a module-LOD frontier, picking/selecting an aggregate yields its subtree leaves via members()", async () => {
    const net = network(host(), { width: 200, height: 200 }); // webgl
    await net.whenReady();
    // Two tight modules of two nodes each (mirrors the #138 SVG LOD test): at k=1 each module
    // collapses to ONE aggregate glyph on the frontier.
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net
      .data(g)
      .style({ directed: true })
      .lod({ modules, expandPx: 20 })
      .layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    net.interactive({ selectable: { multi: true }, hover: true });

    net.setTransform({ k: 1, x: 0, y: 0 }); // zoom out → two collapsed aggregates on the frontier

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tree = (net as any).lodTree;
    const visible = (net as any).instancedLanes.get("network").lane.visible as Uint32Array;
    // The frontier should be the two module aggregates (global ids ≥ leafCount), not the 4 leaves.
    const aggregates = [...visible].filter((id) => id >= tree.leafCount);
    expect(aggregates.length).toBe(2);

    const aggId = aggregates[0]!;
    // Pick at the aggregate's centroid (k=1 ⇒ screen == world).
    const hit = (net as any).pick(tree.cx[aggId], tree.cy[aggId]);
    expect(hit?.layer).toBe("nodes");
    expect((hit?.datum as { aggregate: boolean }).aggregate).toBe(true);
    expect((hit?.datum as { count: number }).count).toBe(2);
    expect(hit?.members?.().length).toBe(2); // the module's two leaf nodes
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Selecting the aggregate exposes the same leaf members through selection().
    net.select("nodes", [aggId]);
    const sel = net.selection();
    expect(sel.map((h) => h.id)).toEqual([aggId]);
    expect(sel[0]!.members?.().length).toBe(2);
    // The companion ring overlay now has geometry for the selected aggregate (proves the ring renders,
    // not just that select() didn't throw): its visible set contains the selected frontier id.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const ringVisible = (net as any).instancedLanes.get("network-highlight").lane.visible as Uint32Array;
    expect([...ringVisible]).toContain(aggId);
    // Clearing the selection empties the ring.
    net.select("nodes", null);
    (net as any).instancedLanes.get("network-highlight").lane.update({ k: 1, x: 0, y: 0 }, 200, 200);
    expect((net as any).instancedLanes.get("network-highlight").lane.visible.length).toBe(0);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    net.destroy();
  });

  it("REPRO: example call order — interactive() before data(), screen sizeMode, enableZoom", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    // Mirror the modular-lod example exactly: interactive() + on() are set in `setup`, BEFORE the
    // render chain (data/style/lod/layout). enableZoom is also wired in setup.
    net.enableZoom([0.1, 40]);
    net.interactive({ selectable: { multi: true }, hover: true });
    net.data(g).style({ sizeMode: "screen", nodeRadius: 6 }).lod({ modules, expandPx: 120, maxAggregateRadius: 26 }).layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    // 1. Is the source lane actually interactive after the chain?
    const entry = (net as any).instancedLanes.get("network");
    expect(entry).toBeTruthy();
    expect(entry.interactive).toBeTruthy();
    expect(entry.interactive.options.selectable).toBeTruthy();
    // 2. Is the companion highlight lane registered?
    expect((net as any).instancedLanes.has("network-highlight")).toBe(true);

    net.setTransform({ k: 1, x: 0, y: 0 });
    const tree = (net as any).lodTree;
    const visible = entry.lane.visible as Uint32Array;
    const agg = [...visible].find((id) => id >= tree.leafCount);
    expect(agg).toBeDefined();
    // 3. Does pick hit the aggregate?
    const hit = (net as any).pick(tree.cx[agg!], tree.cy[agg!]);
    expect(hit?.layer).toBe("nodes");
    // 4. Does selecting it light up the ring lane?
    net.select("nodes", [agg!]);
    expect([...(net as any).instancedLanes.get("network-highlight").lane.visible]).toContain(agg);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    net.destroy();
  });

  it("REPRO via real pointer events: hover rings, click selects (the path the example drives)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    const selFired: number[] = [];
    net.enableZoom([0.1, 40]);
    net.interactive({ selectable: { multi: true }, hover: true }).on("select", (hits) => selFired.push(hits.length));
    net.data(g).style({ sizeMode: "screen", nodeRadius: 6 }).lod({ modules, expandPx: 120, maxAggregateRadius: 26 }).layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    net.setTransform({ k: 1, x: 0, y: 0 });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tree = (net as any).lodTree;
    const agg = [...((net as any).instancedLanes.get("network").lane.visible as Uint32Array)].find((id) => id >= tree.leafCount)!;
    const rect = h.getBoundingClientRect();
    const cx = rect.left + tree.cx[agg], cy = rect.top + tree.cy[agg];

    // Count actual backend repaints — a hover/click at a static transform must REPAINT, not just push
    // the ring buffer (the bug: emitHighlightFor pushed the ring but never render()ed, so it stayed
    // invisible until the next zoom). Asserting lane.visible alone misses this — we assert render() ran.
    const backend = (net as any).handle.backend;
    const origRender = backend.render.bind(backend);
    let renders = 0;
    backend.render = () => { renders++; return origRender(); };
    const ringVisible = () => [...((net as any).instancedLanes.get("network-highlight").lane.visible as Uint32Array)];

    // Hover: a pointermove over the aggregate must light the hover ring AND repaint.
    let before = renders;
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: cx, clientY: cy, bubbles: true }));
    expect(ringVisible()).toContain(agg);
    expect(renders).toBeGreaterThan(before); // canvas was actually repainted with the ring

    // Click (down+up, no move) over the aggregate must select it, fire on("select"), AND repaint.
    before = renders;
    h.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true }));
    h.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: cy, bubbles: true }));
    expect(net.selection().map((s) => s.id)).toContain(agg);
    expect(selFired.at(-1)).toBeGreaterThan(0);
    expect(renders).toBeGreaterThan(before);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    net.destroy();
    h.remove();
  });

  it("works after a canvas→WebGL upgrade, where empty placeholder Scene specs would shadow the lane", async () => {
    // The website harness defaults to backend:"auto" (canvas first, then WebGL). On the upgrade the
    // network keeps empty "nodes"/"links"/… Scene specs (geometry cleared) — these must NOT shadow the
    // interactive lane in selection/hover dispatch. Reproduce via an explicit canvas→webgl swap.
    const net = network(host(), { width: 200, height: 200, backend: "canvas" });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net.interactive({ selectable: { multi: true }, hover: true });
    net.data(g).style({ sizeMode: "screen", nodeRadius: 6 }).lod({ modules, expandPx: 120, maxAggregateRadius: 26 }).layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    net.setBackend("webgl");
    await net.whenReady();
    net.setTransform({ k: 1, x: 0, y: 0 });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    // A placeholder Scene "nodes" spec is present from the canvas phase…
    expect((net as any).specs.some((s: { name: string }) => s.name === "nodes")).toBe(true);
    const tree = (net as any).lodTree;
    const agg = [...((net as any).instancedLanes.get("network").lane.visible as Uint32Array)].find((id) => id >= tree.leafCount)!;
    expect(agg).toBeDefined();

    // …yet selection resolves through the LANE (aggregate members = subtree leaves, not [id]) and the
    // ring lights up — i.e. the placeholder spec does not shadow the lane.
    net.select("nodes", [agg]);
    const sel = net.selection();
    expect(sel.map((s) => s.id)).toEqual([agg]);
    // members = the aggregate's subtree leaves (count > 1) — would be 1 ([agg]) if the placeholder
    // Scene spec shadowed the lane (sceneMembers has no winners for "nodes" → returns [id]).
    expect(sel[0]!.members?.().length).toBe(tree.count[agg]);
    expect(tree.count[agg]).toBeGreaterThan(1);
    expect([...(net as any).instancedLanes.get("network-highlight").lane.visible]).toContain(agg);
    // And the gesture path is selectable through the lane (not the non-selectable placeholder spec).
    const hit = (net as any).pick(tree.cx[agg], tree.cy[agg]);
    expect((hit?.datum as { aggregate: boolean }).aggregate).toBe(true);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    net.destroy();
  });

  it("selection ring coexists with flowBorder + aggregateOutline on a collapsed module (modular-map combo)", async () => {
    // The directed-map-of-modules example combines per-node flow borders + an aggregate outline with
    // interactive selection/hover/drag (#140). Assert that combo renders an aggregate's selection ring
    // (separate companion lane) without throwing — the rings are independent of the glyph borders.
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({
      nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true,
      nodeFlow: new Float32Array([0.4, 0.3, 0.2, 0.1]),
    });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    const ringW = (f: number) => f * 8; // enter/exit-flow ring scale
    net
      .data(g)
      .style({
        directed: true, sizeMode: "screen", linkStyle: "half-arrow",
        nodeRadius: { by: "flow", scale: (f: number) => 4 + f * 10 },
        flowBorder: { flow: new Float32Array([0.5, 0.2, 0.3, 0.1]), scale: ringW },
      })
      .lod({ modules, expandPx: 20, superEdges: true, aggregateOutline: { width: 1.5, gap: 3 } })
      .layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    net.interactive({ selectable: { multi: true }, draggable: true, hover: true });
    net.setTransform({ k: 1, x: 0, y: 0 }); // collapse to two module aggregates

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tree = (net as any).lodTree;
    const agg = [...((net as any).instancedLanes.get("network").lane.visible as Uint32Array)].find((id) => id >= tree.leafCount)!;
    expect(agg).toBeDefined();
    net.select("nodes", [agg]); // ring the collapsed, flow-bordered, outlined module
    // The companion ring lane renders the selected aggregate (coexisting with flowBorder + aggregateOutline).
    expect([...(net as any).instancedLanes.get("network-highlight").lane.visible]).toContain(agg);
    expect(net.selection()[0]!.members?.().length).toBe(tree.count[agg]); // its subtree leaves
    /* eslint-enable @typescript-eslint/no-explicit-any */
    net.destroy();
  });

  it("toggling interactive(false) returns to pick-only (no managed selection)", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) });
    net.interactive({ selectable: true });
    net.select("nodes", [0]);
    expect(net.selection().map((h) => h.id)).toEqual([0]);

    net.interactive(false);
    net.select("nodes", [1]);
    expect(net.selection()).toEqual([]); // pick-only again
    net.destroy();
  });
});

// #162: selection.others dimming + outgoing-link emphasis on the instanced node lane.
describe("network selection.others dim + outgoing links (#162)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const baseLane = (net: any) => net.instancedLanes.get("network").lane;
  const hlLane = (net: any) => net.instancedLanes.get("network-highlight").lane;
  const T = { k: 1, x: 0, y: 0 };
  const emit = (lane: any): any[] => lane.update(T, 200, 200);
  const layer = (layers: any[], name: string) => layers.find((l) => l.name === name);
  const linkColors = (l: any): Uint8Array => (l.primitive === "lines" ? l.lines.colors : l.halfArrows.colors);

  it("#1 selecting a node dims the others to the default 0.3 and keeps the selected node full", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) });
    net.interactive({ selectable: true }); // default selection.others = { opacity: 0.3 }

    const before = layer(emit(baseLane(net)), "nodes").circles.colors as Uint8Array;
    const base = [before[3], before[7], before[11]]; // alpha of nodes 0,1,2 (opaque ⇒ 255)
    expect(base).toEqual([255, 255, 255]);

    net.select("nodes", [1]);
    const after = layer(emit(baseLane(net)), "nodes").circles.colors as Uint8Array;
    expect(after[7]).toBe(255); // selected node 1 stays full
    expect(after[3]).toBe(Math.round(255 * 0.3)); // node 0 dimmed
    expect(after[11]).toBe(Math.round(255 * 0.3)); // node 2 dimmed

    net.select("nodes", null); // clearing the selection removes the dim
    const cleared = layer(emit(baseLane(net)), "nodes").circles.colors as Uint8Array;
    expect([cleared[3], cleared[7], cleared[11]]).toEqual([255, 255, 255]);
    net.destroy();
  });

  it("#1 honors a custom selection.others.opacity", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) });
    net.interactive({ selectable: true, selection: { others: { opacity: 0.5 } } });

    net.select("nodes", [0]);
    const a = layer(emit(baseLane(net)), "nodes").circles.colors as Uint8Array;
    expect(a[3]).toBe(255); // selected node 0 full
    expect(a[7]).toBe(Math.round(255 * 0.5)); // node 1 at the custom opacity
    net.destroy();
  });

  it("#2 a selected node keeps its outgoing links full while other links dim (directed)", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    // Directed chain 0→1→2: node 0's only outgoing edge is edge 0 (0→1).
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });
    net.data(g).style({ nodeRadius: 6, directed: true }).layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) });
    net.interactive({ selectable: true });

    net.select("nodes", [0]);
    const links = linkColors(layer(emit(baseLane(net)), "links"));
    expect(links[3]).toBe(255); // edge 0 (0→1) outgoing from the selected node 0 → full
    expect(links[7]).toBe(Math.round(255 * 0.3)); // edge 1 (1→2) → dimmed
    net.destroy();
  });

  it("#3 hovering a node overlays its outgoing links in the hover lane (transient)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });
    net.data(g).style({ nodeRadius: 8, directed: true }).layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) });
    net.interactive({ selectable: true, hover: true });
    (net as any).setTransform(T);

    // No hover yet → no hover-link layer in the highlight lane.
    expect(layer(emit(hlLane(net)), "network-highlight:hover-links")).toBeUndefined();

    // Hover node 0 (world == screen at k=1) → its single outgoing link (0→1) overlays in the hover lane.
    const rect = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + 10, clientY: rect.top + 10, bubbles: true }));
    const hover = layer(emit(hlLane(net)), "network-highlight:hover-links");
    expect(hover).toBeDefined();
    expect(hover.lines.count).toBe(1); // node 0 has exactly one outgoing edge

    // Moving off clears the transient overlay.
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + 199, clientY: rect.top + 199, bubbles: true }));
    expect(layer(emit(hlLane(net)), "network-highlight:hover-links")).toBeUndefined();
    net.destroy();
    h.remove();
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});
