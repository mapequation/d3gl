import { describe, it, expect, vi, afterEach } from "vitest";
import { network } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import { buildGraph } from "../graph.js";
import type { ModulePathNode } from "../module-colors.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import type { InstancedLayer, InstancedHighlight } from "../../core/backend.js";
import { decodeImage } from "../../map/__tests__/backend-equivalence-harness.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

/**
 * A tiny state network with ONE overlapping physical node (#171):
 *  - physical 0: state nodes 0 (module 1) + 1 (module 2) → spans two modules ⇒ a 2-wedge pie
 *  - physical 1: state node 2 (module 1) ⇒ solid disc
 *  - physical 2: state node 3 (module 2) ⇒ solid disc
 * Undirected, so links are stroked `fill="none"` paths and the ONLY filled paths are pie wedges.
 */
function tinyStateNetwork() {
  const graph = buildStateGraph({
    stateCount: 4,
    stateToPhysical: [0, 0, 1, 2],
    source: [0, 1],
    target: [2, 3], // state edges 0-2 (phys0-phys1), 1-3 (phys0-phys2) → physical edges 0-1, 0-2
    nodeFlow: [1, 1, 1, 1],
    directed: false,
  });
  const modules: ModulePathNode[] = [
    { id: 0, path: [1, 1] },
    { id: 1, path: [2, 1] },
    { id: 2, path: [1, 2] },
    { id: 3, path: [2, 2] },
  ];
  return { graph, modules };
}

const filledPaths = (svg: string) => (svg.match(/<path[^>]*fill="rgba/g) ?? []).length;
const circles = (svg: string) => (svg.match(/<circle/g) ?? []).length;

describe("state-network engine (#171)", () => {
  it("renders overlapping physical nodes as pies in the physical view; toggling to the state view swaps to the rosette", async () => {
    const { graph, modules } = tinyStateNetwork();
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();

    net
      .style({ nodeRadius: 8 })
      .stateNetwork(graph, { modules, view: "physical" })
      .layout({ backend: "positions", positions: new Float32Array([40, 100, 120, 40, 120, 160]) });

    expect(net.stateView).toBe("physical");
    let svg = net.toSVG();
    expect(circles(svg)).toBe(3); // three physical node discs
    expect(filledPaths(svg)).toBe(2); // physical 0's two module wedges (the only filled paths)

    // Toggle to the state view: the four state nodes on a rosette, no pies.
    net.view("state");
    expect(net.stateView).toBe("state");
    svg = net.toSVG();
    expect(circles(svg)).toBe(4); // four state node discs
    expect(filledPaths(svg)).toBe(0); // no pie wedges in the state view

    // Hybrid "both" view: 4 state node discs (circles) + 3 physical **container** discs (filled + black
    // stroked arc paths, drawn under) + state-level links. No pies.
    net.view("both");
    expect(net.stateView).toBe("both");
    svg = net.toSVG();
    expect(circles(svg)).toBe(4); // the 4 state nodes (containers are stroked arc paths, not <circle>)
    expect(filledPaths(svg)).toBe(3); // the 3 faint container discs

    // Back to physical: pies return, containers gone.
    net.view("physical");
    svg = net.toSVG();
    expect(circles(svg)).toBe(3);
    expect(filledPaths(svg)).toBe(2);

    net.destroy();
  });

  it("swapping to a different-sized state network with module LOD on does not throw (stale modules, #171)", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const a = tinyStateNetwork(); // 4 state nodes
    net.stateNetwork(a.graph, { modules: a.modules, view: "state" }).layout({ backend: "force" });
    net.lod({ modules: a.modules }); // module LOD over A's 4 state nodes

    // A DIFFERENT-sized state network (6 state nodes). Before the fix, layout() rebuilt the LOD tree with
    // A's stale 4-record modules over B's 6-node graph → "no record for node id …". stateNetwork() must
    // clear the prior LOD config so this can't happen.
    const b = buildStateGraph({ stateCount: 6, stateToPhysical: [0, 0, 1, 1, 2, 2], source: [0, 2, 4], target: [2, 4, 0] });
    const bModules = Array.from({ length: 6 }, (_, id) => ({ id, path: [(id % 2) + 1, id + 1] }));
    expect(() => net.stateNetwork(b, { modules: bModules, view: "state" }).layout({ backend: "force" })).not.toThrow();
    expect(net.stateView).toBe("state");
    net.destroy();
  });

  it("confines each physical node's state rosette inside its container disc in the both view", async () => {
    const { graph, modules } = tinyStateNetwork();
    const net = network(host(), { width: 200, height: 200 }); // webgl
    await net.whenReady();
    net.stateNetwork(graph, { modules, view: "both" }).layout({ backend: "force" });

    // Each state node is confined to its own physical node's container: it must be nearer to its own
    // physical node than to any other (the rosette radius is a fraction of the inter-node spacing).
    const distTo = (s: number, p: number) => Math.hypot(graph.state.positions[2 * s]! - graph.physical.positions[2 * p]!, graph.state.positions[2 * s + 1]! - graph.physical.positions[2 * p + 1]!);
    for (let s = 0; s < graph.state.nodeCount; s++) {
      const own = graph.stateToPhysical[s]!;
      for (let q = 0; q < graph.physicalCount; q++) {
        if (q !== own) expect(distTo(s, own)).toBeLessThan(distTo(s, q));
      }
    }
    net.destroy();
  });

  it("derives rosette state positions from a force layout of the physical graph (WebGL, no throw)", async () => {
    const { graph, modules } = tinyStateNetwork();
    const net = network(host(), { width: 200, height: 200 }); // default webgl
    await net.whenReady();

    net.stateNetwork(graph, { modules, view: "state" }).layout({ backend: "force" });

    // Physical positions are laid out (not all zero) and rosette state positions are derived from them.
    const physNonZero = Array.from(graph.physical.positions).some((v) => v !== 0);
    const stateNonZero = Array.from(graph.state.positions).some((v) => v !== 0);
    expect(physNonZero).toBe(true);
    expect(stateNonZero).toBe(true);
    // Each state node sits within a small radius of its physical node (rosette containment).
    for (let s = 0; s < graph.state.nodeCount; s++) {
      const p = graph.stateToPhysical[s]!;
      const dx = graph.state.positions[2 * s]! - graph.physical.positions[2 * p]!;
      const dy = graph.state.positions[2 * s + 1]! - graph.physical.positions[2 * p + 1]!;
      const spacing = 200; // generous — just assert they cluster near their physical node, not scatter
      expect(Math.hypot(dx, dy)).toBeLessThan(spacing);
    }

    net.destroy();
  });
});

/** Shared containment assertion for the async-backend tests below (#182): once settled, every state
 *  node's rosette position must cluster near its own physical node, not scatter across the layout — the
 *  same shape of check as the existing "no throw" force-layout test above and `rosette.test.ts`'s
 *  containment case, driven through the engine's async layout path instead of calling `rosettePositions`
 *  directly. A generous bound (well under the 200×200 viewport) rather than the exact rosette radius,
 *  since the radius itself is derived from the converged layout scale (`stateSpacing`) and isn't known
 *  ahead of the assertion. */
function assertRosetteContainment(graph: ReturnType<typeof tinyStateNetwork>["graph"]): void {
  const spacing = 200;
  for (let s = 0; s < graph.state.nodeCount; s++) {
    const p = graph.stateToPhysical[s]!;
    const dx = graph.state.positions[2 * s]! - graph.physical.positions[2 * p]!;
    const dy = graph.state.positions[2 * s + 1]! - graph.physical.positions[2 * p + 1]!;
    expect(Math.hypot(dx, dy)).toBeLessThan(spacing);
  }
}

describe("state-network async layout backends (#182)", () => {
  it("backend: 'gpu' lays out the physical graph, derives the rosette, and reports layoutTransport 'gpu'", async () => {
    const { graph, modules } = tinyStateNetwork();
    const net = network(host(), { width: 200, height: 200, backend: "webgl" });
    await net.whenReady();

    net.stateNetwork(graph, { modules, view: "state" }).layout({ backend: "gpu", iterations: 20 });
    await net.whenSettled();

    expect(net.layoutTransport).toBe("gpu");
    // The physical graph is laid out (not degenerate: at least two distinct positions among 3 nodes).
    const physPositions = new Set(Array.from(graph.physical.positions).map((v) => v.toFixed(3)));
    expect(physPositions.size).toBeGreaterThan(2);
    assertRosetteContainment(graph);

    net.destroy();
  });

  it("backend: 'worker' lays out the physical graph, derives the rosette, and reports a worker transport", async () => {
    const { graph, modules } = tinyStateNetwork();
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();

    net.stateNetwork(graph, { modules, view: "state" }).layout({ backend: "worker", iterations: 20 });
    await net.whenSettled();

    expect(["shared", "copy"]).toContain(net.layoutTransport);
    const physPositions = new Set(Array.from(graph.physical.positions).map((v) => v.toFixed(3)));
    expect(physPositions.size).toBeGreaterThan(2);
    assertRosetteContainment(graph);

    net.destroy();
  });

  it("backend: 'force' still lays out synchronously (unchanged) alongside the new async backends", async () => {
    const { graph, modules } = tinyStateNetwork();
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();

    net.stateNetwork(graph, { modules, view: "state" }).layout({ backend: "force" });

    expect(net.layoutTransport).toBe("none"); // synchronous — no layout handle in flight
    const physPositions = new Set(Array.from(graph.physical.positions).map((v) => v.toFixed(3)));
    expect(physPositions.size).toBeGreaterThan(2);
    assertRosetteContainment(graph);

    net.destroy();
  });

  it("the 'both' view also converges under backend: 'gpu' (container-confined rosette)", async () => {
    const { graph, modules } = tinyStateNetwork();
    const net = network(host(), { width: 200, height: 200, backend: "webgl" });
    await net.whenReady();

    net.stateNetwork(graph, { modules, view: "both" }).layout({ backend: "gpu", iterations: 20 });
    await net.whenSettled();

    expect(net.layoutTransport).toBe("gpu");
    // Each state node must be nearer its own physical node than any other (container confinement).
    const distTo = (s: number, p: number) =>
      Math.hypot(graph.state.positions[2 * s]! - graph.physical.positions[2 * p]!, graph.state.positions[2 * s + 1]! - graph.physical.positions[2 * p + 1]!);
    for (let s = 0; s < graph.state.nodeCount; s++) {
      const own = graph.stateToPhysical[s]!;
      for (let q = 0; q < graph.physicalCount; q++) {
        if (q !== own) expect(distTo(s, own)).toBeLessThan(distTo(s, q));
      }
    }

    net.destroy();
  });
});

// ── #175: the physical-view pie joins the #162 shader highlight ─────────────────────────────────────
//
// A hover/selection restyle on the network lane is a UNIFORM push (`styleInstancedLayer`) plus, for a
// selection, an in-place `selected` flag write — never a geometry re-emit. The pie layer carried its
// per-wedge `groups` (physical node id) since #171 but was left out of that push, so selecting or
// hovering a physical node dimmed every disc and link while the overlapping-module pies stayed at full
// opacity. These tests pin the pie to the same contract, through the real triggers.

/**
 * Two overlapping physical nodes (pies) and one single-module disc:
 *  - physical 0: state 0 (module 1, flow 1) + state 1 (module 2, flow 3) ⇒ wedges [0, 0.25] + [0.25, 1]
 *  - physical 1: state 2 (module 1, flow 1) + state 3 (module 2, flow 3) ⇒ the same split
 *  - physical 2: state 4 (module 1) ⇒ solid disc
 * The 1:3 split makes the SECOND wedge span three quarters of the pie, so {@link pieSample} lands in it
 * whichever way the y axis runs.
 */
function pieStateNetwork() {
  const graph = buildStateGraph({
    stateCount: 5,
    stateToPhysical: [0, 0, 1, 1, 2],
    source: [0, 1, 3],
    target: [2, 4, 4],
    nodeFlow: [1, 3, 1, 3, 1],
    directed: false,
  });
  const modules: ModulePathNode[] = [
    { id: 0, path: [1, 1] },
    { id: 1, path: [2, 1] },
    { id: 2, path: [1, 2] },
    { id: 3, path: [2, 2] },
    { id: 4, path: [1, 3] },
  ];
  return { graph, modules };
}

const PIE_POS = new Float32Array([50, 100, 150, 100, 100, 40]);
const PIE_R = 16;
/** Half-way out from physical `p`'s centre towards the screen's lower left: angle fraction 0.375 (0.625
 *  with y flipped), inside the pie's second (module-2) wedge either way, and clear of every link —
 *  a highlighted link under a faded pie would show through it and mask the fade. */
const pieSample = (p: number): [number, number] => {
  const d = (PIE_R / 2) * Math.SQRT1_2;
  return [(PIE_POS[2 * p] ?? 0) - d, (PIE_POS[2 * p + 1] ?? 0) + d];
};
/** The base network lane's layers — a restyle must never (re)emit any of these. */
const BASE_LANE = new Set(["nodes", "links", "arrows", "pie"]);

function rgbaAt(buf: { width: number; data: Uint8Array }, [x, y]: [number, number]): [number, number, number, number] {
  const o = (Math.round(y) * buf.width + Math.round(x)) * 4;
  return [buf.data[o] ?? 0, buf.data[o + 1] ?? 0, buf.data[o + 2] ?? 0, buf.data[o + 3] ?? 0];
}
const frame = async (net: ReturnType<typeof network>) => decodeImage(net.toPNG(), 200, 200);

/** Typed spies on the WebGL backend's instanced-layer seam (no `any`, no reach into the engine). */
function laneSpy() {
  const set = vi.spyOn(WebGLBackend.prototype, "setInstancedLayer");
  const update = vi.spyOn(WebGLBackend.prototype, "updateInstancedLayer");
  const style = vi.spyOn(WebGLBackend.prototype, "styleInstancedLayer");
  return {
    /** Names of every layer (re)emitted since the last reset — set + in-place update. */
    emitted: (): string[] => [...set.mock.calls, ...update.mock.calls].map(([l]) => l.name),
    /** Every layer object pushed (set + update), in call order. */
    layers: (): InstancedLayer[] => [...set.mock.calls, ...update.mock.calls].map(([l]) => l),
    /** The highlight pushes a layer received. */
    styled: (name: string): InstancedHighlight[] => style.mock.calls.filter(([n]) => n === name).map(([, h]) => h),
    reset(): void {
      set.mockClear();
      update.mockClear();
      style.mockClear();
    },
  };
}
/** The last element, or undefined (the lib target predates `Array.prototype.at`). */
const last = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const pieSelectedOf = (layers: InstancedLayer[]): (Uint8Array | undefined)[] =>
  layers.flatMap((l) => (l.primitive === "pie" ? [l.pie.selected] : []));

async function physicalPies(h: HTMLElement) {
  const { graph, modules } = pieStateNetwork();
  const net = network(h, { width: 200, height: 200, backend: "webgl" });
  await net.whenReady();
  net
    .style({ nodeRadius: PIE_R })
    .stateNetwork(graph, { modules, view: "physical" })
    .layout({ backend: "positions", positions: PIE_POS });
  net.setTransform({ k: 1, x: 0, y: 0 }); // world == screen
  return net;
}

describe("physical-view pie highlight (#175)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selecting a physical node pushes the dim uniform + per-wedge `selected` flags to the pie — no re-emit", async () => {
    const h = host();
    const net = await physicalPies(h);
    net.interactive({ selectable: true }); // default selection.others = { opacity: 0.3 }
    const spy = laneSpy();
    spy.reset();

    net.select("nodes", [1]);

    const pie = spy.styled("pie");
    expect(pie.some((u) => u.dimActive === true && u.dimOpacity === 0.3)).toBe(true);
    // Wedge order = physical order, overlapping nodes only: p0's two wedges, then p1's two.
    const flags = pie.map((u) => u.selected).filter((s): s is Uint8Array => s !== undefined);
    expect(flags.length).toBeGreaterThan(0);
    expect([...(last(flags) ?? [])]).toEqual([0, 0, 1, 1]);
    expect(spy.emitted().filter((n) => BASE_LANE.has(n)), "a selection re-emitted base geometry").toEqual([]);

    net.select("nodes", null);
    expect(last(spy.styled("pie"))?.dimActive).toBe(false);
    net.destroy();
    h.remove();
  });

  it("the unselected pie visibly fades, the selected one keeps full opacity — and a layout frame keeps it so", async () => {
    const h = host();
    const net = await physicalPies(h);
    net.interactive({ selectable: true });
    const before = await frame(net);
    expect(before.data.length).toBeGreaterThan(0);
    const a0 = rgbaAt(before, pieSample(0));
    const a1 = rgbaAt(before, pieSample(1));
    expect(a0[3], "the pie is not drawn at the sample point").toBe(255);

    net.select("nodes", [1]);
    const selected = await frame(net);
    // Dimmed to 0.3 over a disc that is itself dimmed to 0.3 ⇒ ≈ 1 - 0.7² = 0.51 alpha (the accepted
    // double-composite residual). Before #175 the opaque pie covered its dimmed disc: alpha stayed 255.
    expect(rgbaAt(selected, pieSample(0))[3], "the unselected pie did not fade").toBeLessThan(200);
    expect(rgbaAt(selected, pieSample(1)), "the selected pie changed").toEqual(a1);

    // A position-only re-layout re-emits the lane in place. The pie's flags must travel on that emit —
    // a flag-less emit would zero the GPU `a_selected` column and dim the selected pie too.
    net.layout({ backend: "positions", positions: PIE_POS });
    const relaid = await frame(net);
    expect(rgbaAt(relaid, pieSample(1)), "a layout frame cleared the selected pie's flags").toEqual(a1);
    expect(rgbaAt(relaid, pieSample(0))).toEqual(rgbaAt(selected, pieSample(0)));

    net.select("nodes", null);
    expect(rgbaAt(await frame(net), pieSample(0))).toEqual(a0);
    net.destroy();
    h.remove();
  });

  it("hovering a physical node drives the pie's hover uniform — no re-emit — and hover.others fades the other pies", async () => {
    const h = host();
    const net = await physicalPies(h);
    net.interactive({ hover: { others: { opacity: 0.5 } } });
    const before = await frame(net);
    const spy = laneSpy();
    spy.reset();

    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 50, clientY: r.top + 100, bubbles: true }));

    expect(spy.styled("pie").some((u) => u.hoverGroup === 0 && u.dimActive === true && u.dimOpacity === 0.5)).toBe(true);
    expect(spy.emitted().filter((n) => BASE_LANE.has(n)), "a hover re-emitted base geometry").toEqual([]);
    const hovered = await frame(net);
    expect(rgbaAt(hovered, pieSample(1))[3], "the other pie did not fade on hover").toBeLessThan(220);
    expect(rgbaAt(hovered, pieSample(0)), "the hovered pie changed").toEqual(rgbaAt(before, pieSample(0)));

    h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 199, clientY: r.top + 199, bubbles: true }));
    expect(last(spy.styled("pie"))?.hoverGroup).toBe(-1);
    net.destroy();
    h.remove();
  });

  it("a node-drag frame re-emits the pie with the SAME cached flags (no per-move rebuild)", async () => {
    const h = host();
    const net = await physicalPies(h);
    net.interactive({ selectable: true, draggable: true });
    net.select("nodes", [1]);
    const spy = laneSpy();
    spy.reset();

    // Grab the selected p1 and drag it: every move repaints through rebuild → lane re-emit.
    const r = h.getBoundingClientRect();
    const ev = (type: string, x: number, y: number) =>
      h.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
    ev("pointerdown", 150, 100);
    ev("pointermove", 156, 104);
    ev("pointermove", 162, 108);
    ev("pointermove", 168, 112);
    ev("pointerup", 168, 112);

    const emitted = pieSelectedOf(spy.layers());
    expect(emitted.length, "the drag never re-emitted the pie").toBeGreaterThanOrEqual(3);
    const first = emitted[0];
    expect(first, "the drag emitted the pie without its selected flags").toBeDefined();
    expect([...(first ?? [])]).toEqual([0, 0, 1, 1]);
    for (const s of emitted) expect(s, "a drag move rebuilt the pie's selected flags").toBe(first);
    net.destroy();
    h.remove();
  });

  it("the pie never outlives the lane that drew it: lod() in the physical view (pies are not LOD-aware yet, #174) and data() drop it", async () => {
    const live = new Set<string>();
    const origSet = WebGLBackend.prototype.setInstancedLayer;
    const origRemove = WebGLBackend.prototype.removeInstancedLayer;
    vi.spyOn(WebGLBackend.prototype, "setInstancedLayer").mockImplementation(function (this: WebGLBackend, layer: InstancedLayer) {
      live.add(layer.name);
      origSet.call(this, layer);
    });
    vi.spyOn(WebGLBackend.prototype, "removeInstancedLayer").mockImplementation(function (this: WebGLBackend, name: string) {
      live.delete(name);
      origRemove.call(this, name);
    });
    const h = host();
    const net = await physicalPies(h);
    expect(live.has("pie"), "the fixture drew no pie").toBe(true);

    net.lod({});
    expect(live.has("pie"), "a stale pie layer survived the switch to the LOD lane").toBe(false);
    net.lod(false);
    expect(live.has("pie"), "the pie did not come back with LOD off").toBe(true);

    // Same contract when the state network is replaced by a plain graph: its lane has no pie to emit.
    net.data(buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false }));
    expect(live.has("pie"), "a stale pie layer survived data(plainGraph)").toBe(false);
    net.destroy();
    h.remove();
  });
});
