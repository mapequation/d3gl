import { describe, it, expect } from "vitest";
import { network, type Network } from "../network.js";
import { buildStateGraph } from "../state-graph.js";
import type { NetworkGraph } from "../graph.js";
import type { ModuleLink } from "../modules.js";
import type { ModulePathNode } from "../module-colors.js";

/**
 * A state network's module links (#533): `stateNetwork(graph, { modules, moduleLinks })` draws them in the state view
 * exactly as `data(state, { modules, moduleLinks })` draws them for the plain network over the same state graph,
 * lumped (#529) or not, across view switches and lump toggles; the physical and both views have none.
 *
 * Fixture (the #529 lump test's: 6 state nodes over 3 physical nodes, two modules, 5 lumps):
 *  - physical 0: states 0, 1 (module [1]) → lump 0; state 5 (module [2]) → lump 1
 *  - physical 1: state 2 (module [1]) → lump 2; state 4 (module [2]) → lump 3
 *  - physical 2: state 3 (module [2]) → lump 4
 * The graph's links stay inside the modules, as an `.ftree`'s leaf links do: only the module links join them.
 */
const POS = new Float32Array([50, 120, 150, 120, 100, 40]);
/** The state view's nodes: module [1]'s on the left, module [2]'s on the right, each module's members overlapping. */
const STATE_POS = new Float32Array([40, 90, 45, 100, 40, 110, 160, 90, 165, 100, 160, 110]);
/** The lumps (states 0 and 1, 5, 2, 4, 3) where their state nodes are. */
const LUMP_POS = new Float32Array([42, 95, 160, 110, 40, 110, 165, 100, 160, 90]);
const W = 200;
const H = 200;
const STYLE = { nodeRadius: 8, nodeFill: "#888888", linkStroke: "#999999" } as const;
/** Each module drawn as one aggregate (its members overlap; the two modules do not), so the links between them are
 *  drawn as super-edges. */
const LOD = { declutter: false, expandPx: 100 } as const;
const LINKS: ModuleLink[] = [
  { source: [1], target: [2], flow: 0.5 },
  { source: [2, 3], target: [1], flow: 0.2 }, // a leaf endpoint: state 5, lump 1
];

function fixture() {
  const graph = buildStateGraph({
    stateCount: 6,
    stateToPhysical: [0, 0, 1, 2, 1, 0],
    source: [0, 1, 4, 5],
    target: [1, 2, 3, 3],
    nodeFlow: [1, 1, 1, 1, 1, 1],
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

async function engine(): Promise<Network> {
  const net = network(host(), { width: W, height: H });
  await net.whenReady();
  return net;
}

/** Place the active view's nodes and frame world == screen. */
function place(net: Network): void {
  const count = (net.positions?.length ?? 0) / 2;
  net.layout({ backend: "positions", positions: count === 3 ? POS : count === 6 ? STATE_POS : LUMP_POS });
  net.lod(LOD);
  net.setTransform({ k: 1, x: 0, y: 0 });
}

/** What the plain network draws over `graph` with `modules` and `moduleLinks`, at `positions`, as the state view is drawn. */
async function plainSVG(graph: NetworkGraph, positions: ArrayLike<number>, modules: ArrayLike<ModulePathNode>, moduleLinks?: ArrayLike<ModuleLink>): Promise<string> {
  const plain = await engine();
  plain.style(STYLE).data({ ...graph, positions: new Float32Array(2 * graph.nodeCount) }, { modules, moduleLinks });
  plain.layout({ backend: "positions", positions: Float32Array.from(positions) });
  plain.lod(LOD);
  plain.setTransform({ k: 1, x: 0, y: 0 });
  const svg = plain.toSVG();
  plain.destroy();
  return svg;
}

/** The state view's export, checked against the plain network's with and without the module links. */
async function expectStateViewDrawsLinks(net: Network, what: string): Promise<string> {
  expect(net.stateView).toBe("state");
  expect(net.lodSource, what).toBe("modules");
  const lumped = net.lumped;
  const source = fixture();
  const graph = lumped ? lumped.graph.state : source.graph.state;
  const modules = lumped ? (lumped.modules ?? []) : source.modules;
  const links = lumped ? (lumped.moduleLinks ?? undefined) : LINKS;
  const positions = Float32Array.from(net.positions ?? []);
  const svg = net.toSVG();
  expect(svg, `${what}: draws what the plain network draws with the module links`).toBe(await plainSVG(graph, positions, modules, links));
  expect(svg, `${what}: and not what it draws without them`).not.toBe(await plainSVG(graph, positions, modules));
  return svg;
}

describe("state network module links (#533)", () => {
  it("checks moduleLinks up front: they require modules, and every endpoint must be in the hierarchy", async () => {
    const { graph, modules } = fixture();
    const net = await engine();
    net.stateNetwork(graph, { modules, view: "state" });
    expect(() => net.stateNetwork(fixture().graph, { moduleLinks: LINKS })).toThrow(/moduleLinks requires modules/);
    expect(() => net.stateNetwork(fixture().graph, { modules, moduleLinks: [{ source: [9], target: [1], flow: 1 }] })).toThrow(/module link endpoint 9 is not in the module tree/);
    expect(() => net.stateNetwork(fixture().graph, { modules, moduleLinks: [{ source: [1], target: [2, 9], flow: 1 }] })).toThrow(/endpoint 2:9/);
    // The failed calls changed nothing: the first network is still drawn, in its view.
    expect(net.stateView).toBe("state");
    expect((net.positions?.length ?? 0) / 2).toBe(6);
    net.destroy();
  });

  it("the state view draws them as the plain network does, across view switches and lump toggles", async () => {
    const { graph, modules } = fixture();
    const net = await engine();
    net.style(STYLE).stateNetwork(graph, { modules, moduleLinks: LINKS, view: "state" });
    place(net);
    const first = await expectStateViewDrawsLinks(net, "state view");
    net.view("physical");
    net.view("both");
    net.view("state");
    net.setTransform({ k: 1, x: 0, y: 0 });
    expect(net.toSVG(), "the state view again, after the other views").toBe(first);
    net.lump(true);
    place(net);
    expect(net.lumped?.moduleLinks?.map((l) => [Array.from(l.source), Array.from(l.target), l.flow])).toEqual([[[1], [2], 0.5], [[2, 1], [1], 0.2]]);
    await expectStateViewDrawsLinks(net, "lumped state view");
    net.view("physical");
    net.view("state");
    net.setTransform({ k: 1, x: 0, y: 0 });
    await expectStateViewDrawsLinks(net, "lumped state view, after the physical view");
    net.lump(false);
    place(net);
    await expectStateViewDrawsLinks(net, "state view, lumped and back");
    net.destroy();
  });

  it("stateNetwork({ lump }) draws them in the lumped state view from the start", async () => {
    const { graph, modules } = fixture();
    const net = await engine();
    net.style(STYLE).stateNetwork(graph, { modules, moduleLinks: LINKS, view: "state", lump: true });
    place(net);
    await expectStateViewDrawsLinks(net, "lumped state view");
    net.destroy();
  });

  it("draws its links and module links with the directed link style, lumped or not: a state network is directed (#549)", async () => {
    const { graph, modules } = fixture();
    expect(graph.state.directed).toBe(true);
    const net = await engine();
    net.style(STYLE).stateNetwork(graph, { modules, moduleLinks: LINKS, view: "state" });
    for (const lump of [false, true]) {
      net.lump(lump);
      place(net);
      const lumped = net.lumped;
      const state = lumped ? lumped.graph.state : graph.state;
      const stateModules = lumped ? (lumped.modules ?? []) : modules;
      const links = lumped ? (lumped.moduleLinks ?? undefined) : LINKS;
      const positions = Float32Array.from(net.positions ?? []);
      const svg = net.toSVG();
      const what = lump ? "lumped state view" : "state view";
      expect(svg, `${what}: as the plain directed network`).toBe(await plainSVG({ ...state, directed: true }, positions, stateModules, links));
      expect(svg, `${what}: not as the plain undirected one`).not.toBe(await plainSVG({ ...state, directed: false }, positions, stateModules, links));
    }
    net.destroy();
  });

  it("the physical and both views have no module links: they draw as without them", async () => {
    const withLinks = await engine();
    const without = await engine();
    const a = fixture();
    const b = fixture();
    withLinks.style(STYLE).stateNetwork(a.graph, { modules: a.modules, moduleLinks: LINKS, view: "physical" });
    without.style(STYLE).stateNetwork(b.graph, { modules: b.modules, view: "physical" });
    for (const net of [withLinks, without]) place(net);
    expect(withLinks.toSVG(), "the physical view").toBe(without.toSVG());
    for (const net of [withLinks, without]) net.view("both");
    expect(withLinks.toSVG(), "the both view").toBe(without.toSVG());
    withLinks.destroy();
    without.destroy();
  });
});
