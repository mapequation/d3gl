import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import type { NetworkLinkHit } from "../network.js";

/**
 * GPU-readback link picking (#141), end-to-end through the public Network API: `pickLinks(true)` makes
 * `pick()` / `on("hover"|"click")` resolve a link (not just a node) pixel-exactly over the drawn geometry.
 */

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

describe("network GPU link picking (#141)", () => {
  it("is opt-in: a link is not pickable until pickLinks() is enabled", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false });
    net.data(g).style({ linkStyle: "line", linkWidth: 8 }).layout({ backend: "positions", positions: new Float32Array([10, 100, 190, 100]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    // The link runs along y=100; without pickLinks() the gap between nodes resolves to nothing.
    expect(net.pick(100, 100)).toBeNull();
    net.destroy();
  });

  it("resolves a link hit (no-LOD): instance → edge, with source/target/weight", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], weight: [4.5], directed: false });
    net.data(g).style({ linkStyle: "line", linkWidth: 8 }).layout({ backend: "positions", positions: new Float32Array([10, 100, 190, 100]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    // interactive() registers a companion highlight lane on top of the node lane; link picking must still
    // resolve (the engine's GPU step skips lanes without gpuPick and finds the network lane's).
    net.interactive({ hover: true });
    net.pickLinks(true);

    // Over the link midpoint (no node there) → a link hit for edge 0.
    const hit = net.pick(100, 100);
    expect(hit?.layer).toBe("links");
    expect(hit?.id).toBe(0); // edge index, LOD off
    const d = hit?.datum as NetworkLinkHit;
    expect(d.aggregate).toBe(false);
    expect([d.source, d.target].sort()).toEqual([0, 1]);
    expect(d.weight).toBeCloseTo(4.5);

    // A node drawn over the link still wins (CPU node pick runs first).
    expect(net.pick(10, 100)?.layer).toBe("nodes");
    // Empty space → no hit.
    expect(net.pick(100, 40)).toBeNull();
    net.destroy();
  });

  it("resolves a super-edge hit under LOD: aggregate endpoints + summed flow", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    // Two modules of two nodes; the only cross-module edge (1→2) becomes a super-edge between the two
    // collapsed aggregates at k=1 (same setup as the #138/N7c-2 LOD tests).
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], weight: [1, 1, 7], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net
      .data(g)
      // 8-unit glyphs: each module's members (15 apart) overlap, so both stay collapsed (#426).
      .style({ directed: true, linkStyle: "line", linkWidth: 6, nodeRadius: 8 })
      .lod({ modules, expandPx: 20 })
      .layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    net.setTransform({ k: 1, x: 0, y: 0 }); // collapse to two aggregates
    net.pickLinks(true);

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tree = (net as any).lodTree;
    const visible = (net as any).instancedLanes.get("network").lane.visible as Uint32Array;
    const aggs = [...visible].filter((id) => id >= tree.leafCount);
    expect(aggs.length).toBe(2);
    // Pick at the midpoint of the two aggregate centroids — on the straight super-edge between them.
    const [a, b] = aggs as [number, number];
    const mx = (tree.cx[a] + tree.cx[b]) / 2;
    const my = (tree.cy[a] + tree.cy[b]) / 2;
    const hit = (net as any).pick(mx, my);
    expect(hit?.layer).toBe("links");
    const d = hit?.datum as NetworkLinkHit;
    expect(d.aggregate).toBe(true);
    expect([d.source, d.target].sort((x, y) => x - y)).toEqual(aggs.slice().sort((x, y) => x - y));
    expect(d.weight).toBeCloseTo(7); // the single crossing edge's flow
    net.destroy();
  });

  it("resolves a link between two kept leaves under LOD as LOD off does (#447): the edge, by its index", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], weight: [1, 1, 7], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    // Module 1's members (15 apart, 8-unit glyphs) overlap and stay collapsed; module 2's (90 apart) open (#426).
    const positions = new Float32Array([20, 40, 35, 40, 60, 150, 150, 150]);
    net
      .data(g)
      .style({ directed: true, linkStyle: "line", linkWidth: 6, nodeRadius: 8 })
      .lod({ modules, expandPx: 20, crossLevelEdges: true }) // draw the aggregate → open-module leaf link
      .layout({ backend: "positions", positions });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.pickLinks(true);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tree = (net as any).lodTree;
    const visible = [...((net as any).instancedLanes.get("network").lane.visible as Uint32Array)];
    expect(visible.includes(2) && visible.includes(3), "module 2 is open: its two leaves are kept").toBe(true);
    expect(visible.some((id) => id >= tree.leafCount), "module 1 stays an aggregate").toBe(true);
    expect((net as any).leafLinksDrawn, "the one link between two kept leaves (2→3)").toBe(1);
    // On the leaf link 2→3 (y = 150): the edge itself, as LOD off resolves it.
    const leaf = net.pick(105, 150);
    expect(leaf?.layer).toBe("links");
    expect(leaf?.id).toBe(1);
    const d = leaf?.datum as NetworkLinkHit;
    expect(d.aggregate).toBe(false);
    expect([d.source, d.target]).toEqual([2, 3]);
    expect(d.weight).toBeCloseTo(1);
    // On the gathered link from module 1's aggregate to leaf 2: a super-edge, after the leaf links' ids.
    const agg = visible.find((id) => id >= tree.leafCount)!;
    const gathered = net.pick((tree.cx[agg] + 60) / 2, (tree.cy[agg] + 150) / 2);
    expect((gathered?.datum as NetworkLinkHit | undefined)?.aggregate).toBe(true);
    expect((gathered?.datum as NetworkLinkHit).weight).toBeCloseTo(7);
    // LOD off, the same point: the same hit.
    net.lod(false);
    net.setTransform({ k: 1, x: 0, y: 0 });
    const off = net.pick(105, 150);
    expect(off?.id).toBe(leaf?.id);
    expect(off?.datum).toEqual(leaf?.datum);
    net.destroy();
  });
});
