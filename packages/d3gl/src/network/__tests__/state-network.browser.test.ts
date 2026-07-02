import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import type { ModulePathNode } from "../module-colors.js";

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
