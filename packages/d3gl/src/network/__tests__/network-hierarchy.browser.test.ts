import { describe, it, expect, vi, beforeEach } from "vitest";
import { network, type NetworkHit } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import { nestedLayout } from "../nested-layout.js";

// Count module-tree builds (#326): the engine must build the tree once per (graph, hierarchy), not once
// per lod()/layout() call, and never on the pick path.
const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock("../modules.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../modules.js")>();
  return {
    ...mod,
    buildModuleLODTree: (...args: Parameters<typeof mod.buildModuleLODTree>) => {
      builds.count++;
      return mod.buildModuleLODTree(...args);
    },
  };
});

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

/**
 * A ragged two-module map: top module 1 holds sub-modules [1,1] and [1,2] (leaves at depth 3), top
 * module 2 holds four leaves directly (depth 2). World positions put module 1 around (30, 30) and
 * module 2 around (150, 150), each sub-module a 20-unit row pair.
 */
const MODULES: ModuleNode[] = [
  { id: 0, path: [1, 1, 1] }, { id: 1, path: [1, 1, 2] }, { id: 2, path: [1, 2, 1] }, { id: 3, path: [1, 2, 2] },
  { id: 4, path: [2, 1] }, { id: 5, path: [2, 2] }, { id: 6, path: [2, 3] }, { id: 7, path: [2, 4] },
];
/** Another partition of the same graph: four pairs under one top module each. */
const PAIRS: ModuleNode[] = MODULES.map(({ id }) => ({ id, path: [Math.floor(id / 2) + 1, (id % 2) + 1] }));
const POSITIONS = new Float32Array([20, 20, 40, 20, 20, 40, 40, 40, 140, 140, 160, 140, 140, 160, 160, 160]);

function graph(): NetworkGraph {
  return buildGraph({
    nodeCount: 8,
    source: [0, 2, 0, 4, 6, 4, 5, 3],
    target: [1, 3, 2, 5, 7, 6, 7, 4],
    directed: true,
  });
}

/** What `layout({ nested: true })` must produce for `records` on `g` — the pure layout on the same tree. */
function expectedNested(g: NetworkGraph, records: ModuleNode[]): number[] {
  const tree = buildModuleLODTree(g.nodeCount, records, g);
  const parent = tree.parent;
  if (!parent) throw new Error("module trees carry a parent map");
  return Array.from(nestedLayout({ ...tree, parent }, { radius: 10 * Math.sqrt(g.nodeCount), size: g.flow ?? undefined }).positions);
}

const pathOf = (hit: { datum: unknown } | null): readonly number[] | undefined => (hit?.datum as NetworkHit | undefined)?.path;

beforeEach(() => {
  builds.count = 0;
});

describe("engine-owned module hierarchy — data(graph, { modules }) (#326)", () => {
  it("lays out nested with LOD off (force backend), identical to nestedLayout on the same tree", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    const want = expectedNested(g, MODULES);
    net.data(g, { modules: MODULES }).lod(false).layout({ backend: "force", nested: true });
    expect(Array.from(g.positions)).toEqual(want);
    expect(net.lodSource).toBe("none");
    net.destroy();
  });

  it("lays out nested with LOD off on the worker backend", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    const want = expectedNested(g, MODULES);
    net.data(g, { modules: MODULES }).layout({ backend: "worker", nested: true });
    await net.whenSettled();
    expect(Array.from(g.positions)).toEqual(want);
    net.destroy();
  });

  it("a fresh fitted nested layout opens inside the box the camera frames, not at the flat force scale", async () => {
    // The camera frames a cold nested layout's known root disc (radius 10·√N about the origin) before
    // any depth frame arrives, so the first paint's seed must sit inside it. The flat layouts' seed
    // disc sized to the force equilibrium (radius √(repulsion·N/centering) ≈ 31.6·√N) overflows it ~3×.
    const n = 1000;
    const g = buildGraph({ nodeCount: n, source: Array.from({ length: n }, (_, i) => i), target: Array.from({ length: n }, (_, i) => (i + 1) % n) });
    const records: ModuleNode[] = Array.from({ length: n }, (_, id) => ({ id, path: [Math.floor(id / 50) + 1, (id % 50) + 1] }));
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    net.data(g, { modules: records }).layout({ backend: "worker", nested: true, fit: true });
    const radius = 10 * Math.sqrt(n);
    let worst = 0;
    for (let i = 0; i < 2 * n; i++) worst = Math.max(worst, Math.abs(g.positions[i]!));
    net.destroy();
    expect(worst).toBeGreaterThan(0); // seeded, not a pile at the origin
    expect(worst).toBeLessThanOrEqual(radius);
  });

  it("without a hierarchy, nested falls back to the force layout; data(graph) clears a previous one", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES });
    const g2 = graph();
    net.data(g2).lod(false).layout({ backend: "force", nested: true, iterations: 20 });
    expect(Array.from(g2.positions)).not.toEqual(expectedNested(g2, MODULES));
    net.lod({}); // no hierarchy any more ⇒ structural coarsening
    expect(net.lodSource).toBe("main");
    net.destroy();
  });

  it("a nested worker layout under a structural cut keeps the LOD geometry on every streamed depth frame", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).lod({ source: "structure", declutter: false }).layout({ backend: "positions", positions: POSITIONS });
    expect(net.lodSource).toBe("main");
    // Every repaint must cut geometry built from the positions it draws: record the leaves' worst drift
    // between the tree's centroids and the live positions at each rebuild of the run.
    const eng = net as unknown as { rebuild(): unknown; lodTree: { cx: Float32Array; cy: Float32Array } | null };
    const rebuild = eng.rebuild.bind(eng);
    const drift: number[] = [];
    eng.rebuild = () => {
      const tree = eng.lodTree;
      if (tree) {
        let worst = 0;
        for (let i = 0; i < g.nodeCount; i++) worst = Math.max(worst, Math.hypot(tree.cx[i]! - g.positions[i * 2]!, tree.cy[i]! - g.positions[i * 2 + 1]!));
        drift.push(worst);
      }
      return rebuild();
    };
    net.layout({ backend: "worker", nested: true }); // cold: streams one frame per depth
    await net.whenSettled();
    expect(Array.from(g.positions)).toEqual(expectedNested(g, MODULES));
    expect(drift.length).toBeGreaterThan(2); // the depth frames really were repainted
    expect(Math.max(...drift), `drift per rebuild: ${drift.join(", ")}`).toBeLessThan(1e-3);
    net.destroy();
  });

  it("lod(false) keeps the hierarchy: re-enabling LOD and nested layout reuse the one cached tree", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).layout({ backend: "positions", positions: POSITIONS });
    expect(builds.count).toBe(0); // lazily built: nothing needed it yet
    net.lod({});
    expect(net.lodSource).toBe("modules");
    net.lod(false);
    expect(net.lodSource).toBe("none");
    net.layout({ backend: "force", nested: true });
    net.lod({ declutter: false });
    expect(net.lodSource).toBe("modules");
    net.lod({ source: "structure" });
    expect(net.lodSource).toBe("main");
    net.lod({ source: "modules" });
    expect(net.lodSource).toBe("modules");
    expect(builds.count, "the module tree was rebuilt instead of reused").toBe(1);
    // A new data() is new data: the next consumer builds afresh.
    net.data(g, { modules: MODULES }).layout({ backend: "positions", positions: POSITIONS });
    expect(net.lodSource).toBe("modules");
    expect(builds.count).toBe(2);
    net.destroy();
  });

  it("switches the LOD source: modules by default, structure on request, an explicit lod({ modules }) wins", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net
      .data(g, { modules: MODULES })
      .style({ nodeRadius: 5 })
      .layout({ backend: "positions", positions: POSITIONS })
      .lod({ expandPx: 60, declutter: false });
    expect(net.lodSource).toBe("modules");
    // k = 1: the root (≈198px) expands, both top modules (≈28px) stay collapsed.
    expect(net.pick(30, 30)).toMatchObject({ datum: { aggregate: true, count: 4 } });
    expect(pathOf(net.pick(30, 30))).toEqual([1]);

    net.lod({ source: "structure", expandPx: 1, declutter: false });
    expect(net.lodSource).toBe("main");
    // Structural cut, everything expanded: a leaf still reports its own path from the hierarchy.
    expect(net.pick(20, 20)).toMatchObject({ id: 0, datum: { aggregate: false, count: 1 } });
    expect(pathOf(net.pick(20, 20))).toEqual([1, 1, 1]);

    // The back-compat alias overrides the engine hierarchy while it is set…
    net.lod({ modules: PAIRS, expandPx: 60, declutter: false });
    expect(net.lodSource).toBe("modules");
    expect(net.pick(30, 20)).toMatchObject({ datum: { aggregate: true, count: 2 } });
    expect(pathOf(net.pick(30, 20))).toEqual([1]);
    // …and lod(false) drops it; the engine hierarchy is back on the next lod().
    net.lod(false).lod({ expandPx: 60, declutter: false });
    expect(pathOf(net.pick(150, 150))).toEqual([2]);
    net.destroy();
  });

  it("switches between the worker-streamed coarsening tree and the module tree after a worker run", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    net.data(graph(), { modules: MODULES }).lod({ source: "structure" }).layout({ backend: "worker", iterations: 20 });
    await net.whenSettled();
    expect(net.lodSource).toBe("worker");
    // The worker's coarsening tree must not win over a requested module cut…
    net.lod({});
    expect(net.lodSource).toBe("modules");
    // …and switching back re-adopts the worker's tree (no main-thread rebuild).
    net.lod({ source: "structure" });
    expect(net.lodSource).toBe("worker");
    net.destroy();
  });

  it("the alias also drives the nested layout while set", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).lod({ modules: PAIRS }).layout({ backend: "force", nested: true });
    expect(Array.from(g.positions)).toEqual(expectedNested(g, PAIRS));
    net.destroy();
  });

  it("reports hit.path with LOD on (aggregates and leaves) and off (the leaf's own path)", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).style({ nodeRadius: 5 }).layout({ backend: "positions", positions: POSITIONS });

    // LOD off: every node is a leaf; its path is its own record's path — and no tree is built for it.
    expect(net.pick(20, 20)).toMatchObject({ id: 0, datum: { aggregate: false, count: 1 } });
    expect(pathOf(net.pick(20, 20))).toEqual([1, 1, 1]);
    expect(pathOf(net.pick(140, 140))).toEqual([2, 1]);
    expect(builds.count, "a LOD-off pick built the module tree").toBe(0);

    // LOD on, zoomed out: module aggregates carry their module path.
    net.lod({ expandPx: 60, declutter: false });
    expect(pathOf(net.pick(150, 150))).toEqual([2]);
    // Zoomed in 4×: sub-modules expand to leaves, each with its full path.
    net.setTransform({ k: 4, x: 0, y: 0 });
    expect(net.pick(80, 80)).toMatchObject({ id: 0, datum: { aggregate: false } });
    expect(pathOf(net.pick(80, 80))).toEqual([1, 1, 1]);
    expect(pathOf(net.pick(160, 80))).toEqual([1, 1, 2]);
    net.destroy();
  });

  it("reports no path without a hierarchy", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    net.data(graph()).style({ nodeRadius: 5 }).layout({ backend: "positions", positions: POSITIONS });
    expect(net.pick(20, 20)).toMatchObject({ id: 0 });
    expect(pathOf(net.pick(20, 20))).toBeUndefined();
    net.destroy();
  });

  it("validates the hierarchy once, in data(), and leaves the engine unchanged on a misaligned one", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = graph();
    net.data(g, { modules: MODULES }).layout({ backend: "positions", positions: POSITIONS });
    expect(() => net.data(graph(), { modules: MODULES.slice(1) })).toThrow(/no record for node id 0/);
    expect(() => net.data(graph(), { modules: [...MODULES, { id: 3, path: [3, 1] }] })).toThrow(/duplicate record/);
    expect(() => net.data(graph(), { modules: [...MODULES.slice(0, 7), { id: 8, path: [3, 1] }] })).toThrow(/out of range/);
    expect(() => net.data(graph(), { moduleLinks: [] })).toThrow(/requires modules/);
    // A module link endpoint outside the hierarchy throws here too — not later, from a lazy tree build.
    expect(() => net.data(graph(), { modules: MODULES, moduleLinks: [{ source: [99], target: [1], flow: 1 }] })).toThrow(/module link endpoint 99 is not in the module tree/);
    expect(() => net.data(graph(), { modules: MODULES, moduleLinks: [{ source: [1], target: [1, 1, 9], flow: 1 }] })).toThrow(/endpoint 1:1:9/);
    // The failed calls changed nothing: the first graph and its hierarchy are still active.
    net.lod({});
    expect(net.lodSource).toBe("modules");
    expect(builds.count).toBe(1);
    net.destroy();
  });
});
