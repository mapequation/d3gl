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
