import { describe, it, expect } from "vitest";
import { network, type Network, type NetworkHit, type NetworkStyle } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleLink, ModuleNode } from "../modules.js";

/**
 * `update({ flow, modules, moduleLinks })` (#547) re-clusters the plain network the engine holds: it draws exactly
 * what `data(graph, { modules, moduleLinks })` draws for the new flow and modules at the same positions, keeps the
 * positions, the camera and the selection, stops a running layout and starts none.
 *
 * Fixture (the #326 hierarchy test's): 8 nodes, module 1 around (30, 30), module 2 around (150, 150).
 */
const W = 200;
const H = 200;
const MODULES: ModuleNode[] = [
  { id: 0, path: [1, 1, 1] }, { id: 1, path: [1, 1, 2] }, { id: 2, path: [1, 2, 1] }, { id: 3, path: [1, 2, 2] },
  { id: 4, path: [2, 1] }, { id: 5, path: [2, 2] }, { id: 6, path: [2, 3] }, { id: 7, path: [2, 4] },
];
/** The re-clustering: four pairs under one top module each. */
const PAIRS: ModuleNode[] = MODULES.map(({ id }) => ({ id, path: [Math.floor(id / 2) + 1, (id % 2) + 1] }));
/** A link between two pair modules the graph's edges do not join. */
const LINKS: ModuleLink[] = [{ source: [1], target: [4], flow: 0.5 }];
const FLOW = [0.3, 0.05, 0.05, 0.1, 0.2, 0.1, 0.1, 0.1];
const POSITIONS = new Float32Array([20, 20, 40, 20, 20, 40, 40, 40, 140, 140, 160, 140, 140, 160, 160, 160]);
const STYLE: NetworkStyle = { nodeRadius: { by: "flow", scale: (f) => 10 + 20 * f }, nodeFill: { by: "module" }, linkStroke: "#999999" };
/** Each module's members overlap at k = 1, so the cut draws each top module as one aggregate. */
const LOD = { expandPx: 60, declutter: false } as const;

function graph(): NetworkGraph {
  return buildGraph({
    nodeCount: 8,
    source: [0, 2, 0, 4, 6, 4, 5, 3],
    target: [1, 3, 2, 5, 7, 6, 7, 4],
    nodeFlow: [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125],
    directed: true,
  });
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

/** An engine showing `g` with `modules`, at {@link POSITIONS}, world == screen; LOD on unless `lod` is false. */
async function shown(g: NetworkGraph, modules: ArrayLike<ModuleNode> | undefined, moduleLinks: ArrayLike<ModuleLink> | undefined, lod: boolean): Promise<Network> {
  const net = await engine();
  net.data(g, { modules, moduleLinks }).style(STYLE).layout({ backend: "positions", positions: POSITIONS });
  if (lod) net.lod(LOD);
  net.setTransform({ k: 1, x: 0, y: 0 });
  return net;
}

/** What `data()` draws for `graph()` with `flow`, `modules` and `moduleLinks`, at {@link POSITIONS}. */
async function loadedSVG(flow: ArrayLike<number> | null, modules: ArrayLike<ModuleNode> | undefined, moduleLinks: ArrayLike<ModuleLink> | undefined, lod: boolean): Promise<string> {
  const g = graph();
  const net = await shown({ ...g, flow: flow ? Float32Array.from(flow) : g.flow }, modules, moduleLinks, lod);
  const svg = net.toSVG();
  net.destroy();
  return svg;
}

const pathOf = (hit: { datum: unknown } | null): readonly number[] | undefined => (hit?.datum as NetworkHit | undefined)?.path;
const frames = (n: number) => new Promise<void>((resolve) => {
  let left = n;
  const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
  requestAnimationFrame(step);
});

describe("network.update({ flow, modules, moduleLinks }) (#547)", () => {
  for (const lod of [true, false]) {
    it(`draws the new flow and modules as data() would, keeping the positions, with LOD ${lod ? "on" : "off"}`, async () => {
      const g = graph();
      const flowBefore = g.flow;
      const net = await shown(g, MODULES, undefined, lod);
      const before = net.toSVG();
      const positions = Array.from(g.positions);
      const flow = FLOW.slice();
      net.update({ flow, modules: PAIRS, moduleLinks: LINKS });
      expect(Array.from(g.positions)).toEqual(positions);
      expect(net.positions).toBe(g.positions); // the same buffer: nothing re-seeded
      expect(net.layoutTransport).toBe("none"); // no layout started
      const after = net.toSVG();
      expect(after).not.toBe(before);
      expect(after).toBe(await loadedSVG(FLOW, PAIRS, LINKS, lod));
      // The caller's arrays are never written, and the caller's graph keeps its own flow.
      expect(flow).toEqual(FLOW);
      expect(g.flow).toBe(flowBefore);
      await frames(3);
      expect(Array.from(g.positions)).toEqual(positions);
      net.destroy();
    });
  }

  it("draws the new hierarchy's module tree and links in the cut, and picks report the new paths", async () => {
    const net = await shown(graph(), MODULES, undefined, true);
    expect(net.pick(150, 150)).toMatchObject({ datum: { aggregate: true, count: 4 } });
    net.update({ modules: PAIRS, moduleLinks: LINKS });
    expect(net.lodSource).toBe("modules");
    expect(net.pick(30, 20)).toMatchObject({ datum: { aggregate: true, count: 2 } });
    expect(pathOf(net.pick(30, 20))).toEqual([1]);
    expect(pathOf(net.pick(150, 160))).toEqual([4]);
    net.destroy();
  });

  it("a field left out is unchanged: flow alone keeps the modules, modules alone keep the flow", async () => {
    const links: ModuleLink[] = [{ source: [1], target: [2], flow: 0.5 }];
    const net = await shown(graph(), MODULES, links, true);
    net.update({ flow: FLOW });
    expect(net.toSVG()).toBe(await loadedSVG(FLOW, MODULES, links, true));
    net.update({ modules: PAIRS }); // new modules clear the held module links
    expect(net.toSVG()).toBe(await loadedSVG(FLOW, PAIRS, undefined, true));
    net.destroy();
  });

  it("modules: null removes the modules and their links", async () => {
    const net = await shown(graph(), PAIRS, LINKS, true);
    net.update({ modules: null });
    expect(net.lodSource).not.toBe("modules");
    expect(pathOf(net.pick(20, 20))).toBeUndefined();
    expect(net.toSVG()).toBe(await loadedSVG(null, undefined, undefined, true));
    net.destroy();
  });

  it("keeps the selection and the camera", async () => {
    const net = await shown(graph(), MODULES, undefined, false);
    net.setTransform({ k: 2, x: -10, y: -20 });
    net.interactive({ selectable: { multi: true } });
    net.select("nodes", [0, 5]);
    expect(net.selection().map((h) => h.id).sort()).toEqual([0, 5]);
    net.update({ flow: FLOW, modules: PAIRS });
    expect(net.selection().map((h) => h.id).sort()).toEqual([0, 5]);
    // The camera holds: node 0 (world 20, 20) is still drawn at screen 2·20 − 10, 2·20 − 20.
    expect(net.pick(30, 20)).toMatchObject({ id: 0 });
    expect(net.pick(140, 140)).toBeNull(); // node 4's place at k = 1: empty at k = 2
    net.destroy();
  });

  it("stops a running layout and starts none; the positions stay where it left them", async () => {
    const g = graph();
    const net = await engine();
    net.data(g, { modules: MODULES }).layout({ backend: "worker" });
    expect(net.layoutTransport).not.toBe("none");
    net.update({ modules: PAIRS });
    expect(net.layoutTransport).toBe("none");
    const positions = Array.from(g.positions);
    await frames(10);
    expect(Array.from(g.positions)).toEqual(positions);
    // The caller continues it warm.
    net.layout({ backend: "force" });
    expect(Array.from(g.positions)).not.toEqual(positions);
    net.destroy();
  });

  it("checks everything first: invalid input throws with the engine unchanged", async () => {
    const net = await shown(graph(), MODULES, undefined, true);
    const before = net.toSVG();
    expect(() => net.update({ flow: [1, 2, 3] })).toThrow(/network\.update: flow length 3 !== nodeCount 8/);
    expect(() => net.update({ flow: FLOW, modules: MODULES.slice(1) })).toThrow(/no record for node id 0/);
    expect(() => net.update({ flow: FLOW, modules: PAIRS, moduleLinks: [{ source: [99], target: [1], flow: 1 }] })).toThrow(/endpoint 99/);
    expect(() => net.update({ flow: FLOW, modules: null, moduleLinks: LINKS })).toThrow(/requires modules/);
    expect(net.toSVG()).toBe(before);
    expect(net.lodSource).toBe("modules");
    expect(pathOf(net.pick(150, 150))).toEqual([2]);
    net.destroy();
  });

  it("throws with no network loaded", async () => {
    const net = await engine();
    expect(() => net.update({ flow: FLOW })).toThrow(/network\.update: no network loaded/);
    net.destroy();
  });
});
