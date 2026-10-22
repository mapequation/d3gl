import { describe, it, expect, afterEach } from "vitest";
import { network, type Network, type NetworkHit } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import type { ModulePathNode } from "../module-colors.js";
import type { HoverHit } from "../../map/base-engine.js";

/**
 * Lumped state networks (#529): the state and both views draw one node per (leaf module, physical node), the physical
 * view the same either way, and `lump()` toggles it keeping the physical layout and mapping the selection.
 *
 * Fixture (6 state nodes over 3 physical nodes, 5 lumps):
 *  - physical 0: states 0, 1 (leaf module [1]) → lump 0; state 5 (leaf module [2]) → lump 1
 *  - physical 1: state 2 (leaf module [1]) → lump 2; state 4 (leaf module [2]) → lump 3
 *  - physical 2: state 3 (leaf module [2]) → lump 4
 */
const S = 6;
const L = 5;
const P = 3;
const POS = new Float32Array([50, 120, 150, 120, 100, 40]);
const W = 200;
const H = 200;

function fixture() {
  const graph = buildStateGraph({
    stateCount: S,
    stateToPhysical: [0, 0, 1, 2, 1, 0],
    // 0->2 and 1->2 merge into lump 0 -> lump 2; 0->1 is inside lump 0; 4->3 is lump 3 -> 4; 5->0 lump 1 -> 0.
    source: [0, 1, 0, 4, 5],
    target: [2, 2, 1, 3, 0],
    nodeFlow: [1, 1, 1, 1, 1, 1],
    directed: true,
  });
  const modules: ModulePathNode[] = [
    { id: 0, path: [1, 1] },
    { id: 1, path: [1, 2] },
    { id: 2, path: [1, 3] },
    { id: 3, path: [2, 2] },
    { id: 4, path: [2, 1] },
    { id: 5, path: [2, 3] },
  ];
  return { graph, modules };
}

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

async function engine(backend: "webgl" | "canvas" | "svg" = "webgl"): Promise<Network> {
  const net = network(host(), { width: W, height: H, backend });
  await net.whenReady();
  return net;
}

/** Place the physical nodes and frame world == screen (k = 1); the state view starts from its rosette around them. */
function place(net: Network): void {
  const view = net.stateView;
  if (view === "state") net.view("physical");
  net.layout({ backend: "positions", positions: POS });
  if (view === "state") net.view("state");
  net.setTransform({ k: 1, x: 0, y: 0 });
}

/** How many nodes the active view draws: its positions' length over 2. */
const drawn = (net: Network): number => (net.positions?.length ?? 0) / 2;
/** The `<circle>`s of an export without a stroke ring: the dots, not the both view's containers. */
const dots = (svg: string): number => [...svg.matchAll(/<circle([^>]*)>/g)].filter((m) => !(Number(/\bstroke-width="([^"]+)"/.exec(m[1] ?? "")?.[1] ?? 0) > 0)).length;
const ids = (hits: readonly HoverHit[]): number[] => hits.map((h) => h.id as number).sort((a, b) => a - b);
const last = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

afterEach(() => {
  document.body.innerHTML = "";
});

describe("lumped state networks (#529)", () => {
  it("stateNetwork({ lump }) draws the lumps in the state and both views, and the physical view as without it", async () => {
    const { graph, modules } = fixture();
    const net = await engine();
    net.stateNetwork(graph, { modules, view: "physical", lump: true });
    place(net);
    expect(drawn(net), "the physical view").toBe(P);
    expect(net.lumped?.graph.physical, "the lumped network shares the physical graph").toBe(graph.physical);
    net.view("state");
    expect(drawn(net), "the state view draws the lumps").toBe(L);
    net.view("both");
    expect(drawn(net), "the both view draws the lumps").toBe(L);
    expect(Array.from(net.lumped?.stateToLump ?? [])).toEqual([0, 0, 2, 4, 3, 1]);
    net.destroy();
  });

  it("lump() toggles the state and both views and leaves the physical layout where it is", async () => {
    const { graph, modules } = fixture();
    const net = await engine();
    net.stateNetwork(graph, { modules, view: "physical", lump: true });
    place(net);
    const physical = Float32Array.from(net.positions ?? []);
    net.lump(false);
    expect(net.lumped).toBeNull();
    expect(Array.from(net.positions ?? []), "the physical layout").toEqual(Array.from(physical));
    net.view("state");
    expect(drawn(net), "the state nodes as given").toBe(S);
    net.lump(true);
    expect(drawn(net), "the lumps").toBe(L);
    net.view("physical");
    expect(Array.from(net.positions ?? []), "the physical layout, after both toggles").toEqual(Array.from(physical));
    net.destroy();
  });

  it("the first lumped state layout starts with each lump at its state nodes' centroid", async () => {
    const { graph, modules } = fixture();
    const net = await engine();
    net.stateNetwork(graph, { modules, view: "state" });
    place(net);
    const states = Float32Array.from(net.positions ?? []);
    expect(states.length).toBe(2 * S);
    net.lump(true);
    const lumps = net.positions ?? new Float32Array(0);
    // Lump 0 is states 0 and 1; lump 4 is state 3 alone.
    expect(lumps[0]).toBeCloseTo((states[0]! + states[2]!) / 2, 4);
    expect(lumps[1]).toBeCloseTo((states[1]! + states[3]!) / 2, 4);
    expect(lumps[8]).toBeCloseTo(states[6]!, 4);
    expect(lumps[9]).toBeCloseTo(states[7]!, 4);
    // Back to the state nodes as given: their own layout, where it was.
    net.lump(false);
    expect(Array.from(net.positions ?? [])).toEqual(Array.from(states));
    net.destroy();
  });

  it("the selection follows the toggle and the view switches, and on('select') hears it", async () => {
    const { graph, modules } = fixture();
    const net = await engine();
    net.stateNetwork(graph, { modules, view: "state" });
    place(net);
    net.interactive({ selectable: { multi: true }, hover: true });
    const seen: HoverHit[][] = [];
    net.on("select", (hits) => seen.push(hits));

    net.select("nodes", [1, 3]);
    net.lump(true);
    expect(ids(net.selection()), "state 1 → lump 0, state 3 → lump 4").toEqual([0, 4]);
    expect(ids(last(seen) ?? []), "the mapped selection was not announced").toEqual([0, 4]);
    expect(net.selection().every((h) => (h.datum as NetworkHit).level === "state")).toBe(true);

    net.select("nodes", [0]);
    net.lump(false);
    expect(ids(net.selection()), "lump 0 → states 0 and 1").toEqual([0, 1]);

    net.lump(true);
    net.select("nodes", [3]);
    net.view("physical");
    expect(ids(net.selection()), "lump 3 → physical 1").toEqual([1]);
    net.view("both");
    expect(ids(net.selection()), "physical 1 → its lumps").toEqual([2, 3]);

    net.select("nodes", [L + 2]); // physical 2's container
    net.lump(false);
    expect(ids(net.selection()), "a container stays its physical node's").toEqual([S + 2]);
    net.destroy();
  });

  it("is a no-op without modules", async () => {
    const { graph } = fixture();
    const net = await engine();
    net.stateNetwork(graph, { view: "state", lump: true });
    place(net);
    expect(net.lumped).toBeNull();
    net.lump(true);
    expect(net.lumped).toBeNull();
    expect(drawn(net)).toBe(S);
    net.destroy();
  });

  for (const backend of ["webgl", "canvas", "svg"] as const) {
    it(`draws the lumps in the state and both views on ${backend}`, async () => {
      const { graph, modules } = fixture();
      const net = await engine(backend);
      net.stateNetwork(graph, { modules, view: "state", lump: true });
      place(net);
      expect(dots(net.toSVG()), "the state view's lumps").toBe(L);
      net.view("both");
      expect(dots(net.toSVG()), "the both view's lumps").toBe(L);
      net.lump(false);
      expect(dots(net.toSVG()), "the both view's state nodes").toBe(S);
      net.destroy();
    });
  }
});
