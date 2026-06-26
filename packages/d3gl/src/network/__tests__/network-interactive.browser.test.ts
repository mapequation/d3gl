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
