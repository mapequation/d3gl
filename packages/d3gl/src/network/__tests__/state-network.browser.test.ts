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

    // Back to physical: pies return.
    net.view("physical");
    svg = net.toSVG();
    expect(circles(svg)).toBe(3);
    expect(filledPaths(svg)).toBe(2);

    net.destroy();
  });

  it("derives rosette state positions from a force layout of the physical graph (WebGL, no throw)", async () => {
    const { graph, modules } = tinyStateNetwork();
    const net = network(host(), { width: 200, height: 200 }); // default webgl
    await net.whenReady();

    net.stateNetwork(graph, { modules }).layout({ backend: "force" });

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
