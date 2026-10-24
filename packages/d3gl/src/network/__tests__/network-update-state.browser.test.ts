import { describe, it, expect, afterEach } from "vitest";
import { network, type Network, type NetworkStyle } from "../network.js";
import { buildStateGraph, type StateNetworkGraph } from "../state-graph.js";
import type { ModulePathNode } from "../module-colors.js";
import type { HoverHit } from "../../map/base-engine.js";

/**
 * `update({ flow, modules, moduleLinks })` (#547) on a state network: indexed per state node, it re-derives the
 * physical flow, the pies, the module colours and the lumps, and keeps every view's positions and layout state.
 * What it draws is what a fresh `stateNetwork()` load of the re-clustered network draws at the same positions.
 *
 * Fixture (the #529 lump test's): 6 state nodes over 3 physical nodes.
 *  - MODULES, 5 lumps: physical 0 = {0, 1} [1] + {5} [2]; physical 1 = {2} [1] + {4} [2]; physical 2 = {3} [2].
 *  - RECLUSTERED, 4 lumps: physical 0 = {0, 1, 5} [1]; physical 1 = {2} [2] + {4} [1]; physical 2 = {3} [2].
 */
const S = 6;
const L = 5;
const L2 = 4;
const POS = new Float32Array([50, 120, 150, 120, 100, 40]);
const W = 200;
const H = 200;
const STATE_TO_PHYSICAL = [0, 0, 1, 2, 1, 0];
const MODULES: ModulePathNode[] = [
  { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [1, 3] },
  { id: 3, path: [2, 2] }, { id: 4, path: [2, 1] }, { id: 5, path: [2, 3] },
];
const RECLUSTERED: ModulePathNode[] = [
  { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] },
  { id: 3, path: [2, 2] }, { id: 4, path: [1, 3] }, { id: 5, path: [1, 4] },
];
const FLOW = [3, 1, 2, 1, 1, 4];
const STYLE: NetworkStyle = { nodeRadius: { by: "flow", scale: (f) => 4 + 3 * f } };

function stateGraph(flow: ArrayLike<number>): StateNetworkGraph {
  return buildStateGraph({ stateCount: S, stateToPhysical: STATE_TO_PHYSICAL, source: [0, 1, 0, 4, 5], target: [2, 2, 1, 3, 0], nodeFlow: flow });
}

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

async function engine(): Promise<Network> {
  const net = network(host(), { width: W, height: H });
  await net.whenReady();
  return net;
}

/** A state network placed physical-first at {@link POS}, every view shown once, then `view`; world == screen. */
async function shown(graph: StateNetworkGraph, modules: ArrayLike<ModulePathNode>, view: "state" | "physical" | "both", lump: boolean): Promise<Network> {
  const net = await engine();
  net.stateNetwork(graph, { modules, view: "physical" }).style(STYLE);
  net.layout({ backend: "positions", positions: POS });
  net.setTransform({ k: 1, x: 0, y: 0 });
  net.view("state"); // seeded from the physical layout, a rosette
  if (lump) net.lump(true);
  net.view("both");
  net.view(view);
  return net;
}

/** What a fresh load of the re-clustered network draws in `view`, with the physical and state views at `at`. */
async function loadedSVG(view: "state" | "physical" | "both", lump: boolean, at: { physical: Float32Array; state: Float32Array }): Promise<string> {
  const net = await engine();
  net.stateNetwork(stateGraph(FLOW), { modules: RECLUSTERED, view: "physical", lump }).style(STYLE);
  net.layout({ backend: "positions", positions: at.physical });
  net.setTransform({ k: 1, x: 0, y: 0 });
  net.view("state");
  net.layout({ backend: "positions", positions: at.state });
  net.view(view);
  const svg = net.toSVG();
  net.destroy();
  return svg;
}

/** The active view's positions, a copy. */
const copy = (net: Network): number[] => Array.from(net.positions ?? []);
/** The positions of the `family` view, shown for the read and back. */
function positionsOf(net: Network, family: "state" | "physical"): number[] {
  const view = net.stateView ?? "physical";
  if (view === family) return copy(net);
  net.view(family);
  const out = copy(net);
  net.view(view);
  return out;
}
const ids = (hits: readonly HoverHit[]): number[] => hits.map((h) => h.id as number).sort((a, b) => a - b);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("network.update() on a state network (#547)", () => {
  for (const view of ["physical", "state", "both"] as const) {
    it(`unlumped, in the ${view} view: keeps every view's positions, starts no layout, and draws as a fresh load`, async () => {
      const graph = stateGraph([1, 1, 1, 1, 1, 1]);
      const net = await shown(graph, MODULES, view, false);
      const physical = positionsOf(net, "physical");
      const state = positionsOf(net, "state");
      const caller = { stateFlow: Array.from(graph.state.flow ?? []), physicalFlow: Array.from(graph.physical.flow ?? []) };
      net.update({ flow: FLOW, modules: RECLUSTERED });
      expect(net.layoutTransport).toBe("none");
      expect(net.stateView).toBe(view);
      // The caller's graph is never written.
      expect(Array.from(graph.state.flow ?? [])).toEqual(caller.stateFlow);
      expect(Array.from(graph.physical.flow ?? [])).toEqual(caller.physicalFlow);
      expect(net.toSVG()).toBe(await loadedSVG(view, false, { physical: Float32Array.from(physical), state: Float32Array.from(state) }));
      expect(positionsOf(net, "physical")).toEqual(physical);
      expect(positionsOf(net, "state")).toEqual(state);
      // View switches afterwards draw as after a load.
      for (const next of ["physical", "state", "both"] as const) {
        net.view(next);
        expect(net.toSVG(), `${next} after the update`).toBe(await loadedSVG(next, false, { physical: Float32Array.from(physical), state: Float32Array.from(state) }));
      }
      net.destroy();
    });
  }

  it("lumped: new lumps start at their state nodes' centroid in the state view's picture, and draw as a fresh load", async () => {
    const net = await shown(stateGraph([1, 1, 1, 1, 1, 1]), MODULES, "state", true);
    const physical = positionsOf(net, "physical");
    const old = copy(net); // the 5 old lumps
    expect(old.length).toBe(2 * L);
    net.update({ flow: FLOW, modules: RECLUSTERED });
    expect(net.layoutTransport).toBe("none");
    const lumps = copy(net);
    expect(lumps.length).toBe(2 * L2);
    // New lump 0 = states 0, 1 (old lump 0) and 5 (old lump 1); new lump 1 = state 2 (old lump 2); 2 = state 4 (old
    // lump 3); 3 = state 3 (old lump 4).
    expect(lumps[0]).toBeCloseTo((2 * old[0]! + old[2]!) / 3, 4);
    expect(lumps[1]).toBeCloseTo((2 * old[1]! + old[3]!) / 3, 4);
    expect(lumps.slice(2)).toEqual(old.slice(4));
    expect(net.lumped?.graph.state.nodeCount).toBe(L2);
    expect(net.toSVG()).toBe(await loadedSVG("state", true, { physical: Float32Array.from(physical), state: Float32Array.from(lumps) }));
    expect(positionsOf(net, "physical")).toEqual(physical);
    net.view("both");
    expect(net.toSVG()).toBe(await loadedSVG("both", true, { physical: Float32Array.from(physical), state: Float32Array.from(lumps) }));
    net.view("physical");
    expect(net.toSVG()).toBe(await loadedSVG("physical", true, { physical: Float32Array.from(physical), state: Float32Array.from(lumps) }));
    net.destroy();
  });

  it("lumped: the unlumped state level keeps its layout, and lump on/off afterwards behaves as after a load", async () => {
    const net = await shown(stateGraph([1, 1, 1, 1, 1, 1]), MODULES, "state", false);
    net.lump(true);
    net.update({ flow: FLOW, modules: RECLUSTERED });
    const lumps = copy(net);
    net.lump(false);
    const back = copy(net);
    expect(back.length).toBe(2 * S);
    // Unfolded around the new lumps, as lump(false) unfolds them: each lump's state nodes centred on it.
    expect((back[0]! + back[2]! + back[10]!) / 3).toBeCloseTo(lumps[0]!, 3);
    expect(back[6]).toBeCloseTo(lumps[6]!, 4);
    net.lump(true);
    expect(copy(net).length).toBe(2 * L2);
    for (let i = 0; i < 2 * L2; i++) expect(copy(net)[i], `coordinate ${i}`).toBeCloseTo(lumps[i]!, 3);
    // Unlumped and updated in the physical view: the state level keeps its picture, and lumping makes the new lumps.
    const plain = await shown(stateGraph([1, 1, 1, 1, 1, 1]), MODULES, "physical", true);
    plain.lump(false);
    const kept = positionsOf(plain, "state");
    plain.update({ modules: RECLUSTERED });
    expect(positionsOf(plain, "state")).toEqual(kept);
    plain.view("state");
    plain.lump(true);
    expect(copy(plain).length).toBe(2 * L2);
    expect(copy(plain)[0]).toBeCloseTo((kept[0]! + kept[2]! + kept[10]!) / 3, 4);
    net.destroy();
    plain.destroy();
  });

  it("stops running and parked layouts; positions stay, and a view shown again does not resume them", async () => {
    const graph = stateGraph([1, 1, 1, 1, 1, 1]);
    const net = await engine();
    net.stateNetwork(graph, { modules: MODULES, view: "physical" });
    net.layout({ backend: "worker" });
    await net.whenSettled();
    net.view("state"); // laid out on first show; the physical run parks alive
    await net.whenSettled();
    net.view("physical");
    expect(net.layoutTransport, "the parked physical run, restored").not.toBe("none");
    net.view("state");
    net.layout({ backend: "worker" }); // running
    const physical = Array.from(graph.physical.positions);
    net.update({ flow: FLOW, modules: RECLUSTERED });
    expect(net.layoutTransport).toBe("none");
    const state = Array.from(graph.state.positions);
    await new Promise((r) => setTimeout(r, 100));
    expect(Array.from(graph.state.positions)).toEqual(state);
    net.view("physical");
    expect(net.layoutTransport, "the parked run was stopped").toBe("none");
    expect(Array.from(graph.physical.positions)).toEqual(physical);
    net.view("state");
    expect(net.layoutTransport, "the stopped run does not resume").toBe("none");
    net.destroy();
  });

  it("a parked view whose run update() stopped before it settled runs again, warm, from its kept positions", async () => {
    const graph = stateGraph([1, 1, 1, 1, 1, 1]);
    const net = await engine();
    net.stateNetwork(graph, { modules: MODULES, view: "physical" });
    net.layout({ backend: "worker" });
    await net.whenSettled();
    net.view("state"); // laid out on first show
    await net.whenSettled();
    net.layout({ backend: "worker" }); // running…
    net.view("physical"); // …and stopped before it settled: parked to go on
    net.update({ flow: FLOW, modules: RECLUSTERED });
    expect(net.layoutTransport, "the active view is the caller's: nothing starts").toBe("none");
    const state = Array.from(graph.state.positions);
    net.view("state");
    expect(net.layoutTransport, "the stopped run goes on").not.toBe("none");
    expect(Array.from(graph.state.positions), "from the kept positions").toEqual(state);
    await net.whenSettled();
    expect(Array.from(graph.state.positions), "a warm run, not a fresh layout").not.toEqual(state);
    net.destroy();
  });

  it("new modules drop a selected state-view module of the old ones; nodes and lumps are kept", async () => {
    const net = await shown(stateGraph([1, 1, 1, 1, 1, 1]), MODULES, "state", false);
    net.lod({ expandPx: 60, declutter: false });
    expect(net.lodSource).toBe("modules");
    net.interactive({ selectable: { multi: true } });
    const seen: number[][] = [];
    net.on("select", (hits) => seen.push(ids(hits)));
    net.select("nodes", [1, S]); // state 1 and a module of the state view's tree
    net.update({ flow: FLOW });
    expect(ids(net.selection()), "the same modules: the module stays selected").toEqual([1, S]);
    net.update({ modules: RECLUSTERED });
    expect(ids(net.selection()), "the old module is dropped, the state node stays").toEqual([1]);
    expect(seen.at(-1), "the selection left is announced").toEqual([1]);
    net.lump(true); // state 1 → lump 0 under RECLUSTERED
    net.select("nodes", [0, L2]); // lump 0 and a module of the lumps' tree
    net.update({ modules: MODULES }); // lump 0's states 0, 1, 5 → lumps 0, 0, 1
    expect(ids(net.selection())).toEqual([0, 1]);
    net.destroy();
  });

  it("keeps the selection: the same ids, and a lump's through its state nodes", async () => {
    const net = await shown(stateGraph([1, 1, 1, 1, 1, 1]), MODULES, "state", false);
    net.interactive({ selectable: { multi: true } });
    net.select("nodes", [1, 3]);
    net.update({ flow: FLOW, modules: RECLUSTERED });
    expect(ids(net.selection())).toEqual([1, 3]);
    net.lump(true); // states 1, 3 → their lumps under RECLUSTERED: 0 and 3
    net.select("nodes", [0, 3]);
    net.update({ modules: MODULES }); // back: states 0, 1, 5 → lumps 0, 0, 1; state 3 → lump 4
    expect(ids(net.selection())).toEqual([0, 1, 4]);
    net.view("both");
    net.select("nodes", [L + 2]); // physical 2's container
    net.update({ modules: RECLUSTERED });
    expect(ids(net.selection()), "a container stays its physical node's").toEqual([L2 + 2]);
    net.destroy();
  });

  it("checks everything first: invalid input throws with the engine unchanged", async () => {
    for (const lump of [false, true]) {
      const net = await shown(stateGraph([1, 1, 1, 1, 1, 1]), MODULES, "state", lump);
      const svg = net.toSVG();
      const positions = copy(net);
      expect(() => net.update({ flow: [1, 2, 3] })).toThrow(/network\.update: flow length 3 !== nodeCount 6/);
      expect(() => net.update({ flow: FLOW, modules: RECLUSTERED.slice(1) })).toThrow(/no record for node id 0/);
      expect(() => net.update({ flow: FLOW, modules: RECLUSTERED, moduleLinks: [{ source: [99], target: [1], flow: 1 }] })).toThrow(/endpoint 99/);
      expect(() => net.update({ modules: null, moduleLinks: [{ source: [1], target: [2], flow: 1 }] })).toThrow(/requires modules/);
      expect(net.toSVG()).toBe(svg);
      expect(copy(net)).toEqual(positions);
      net.destroy();
    }
  });
});
