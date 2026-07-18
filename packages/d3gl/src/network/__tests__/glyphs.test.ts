import { describe, it, expect } from "vitest";
import { nodeCircles, linkLines, linkArrows, halfArrowLinks, networkLayers, networkLayersFromCache, noLodStyleCache, pickNodes, resolveNodeRadii, resolveImportance, resolveLinkColorOf, resolveLinkStrokeOf, type ResolvedNetworkStyle } from "../glyphs.js";
import { buildGraph } from "../graph.js";

/** A resolved style with a uniform radius for `n` nodes (defaults applied elsewhere). */
const style = (n: number): ResolvedNetworkStyle => ({
  nodeRadii: new Float32Array(n).fill(4),
  nodeRadiusAggregate: null,
  importance: new Float32Array(n).fill(1),
  nodeFill: "#000000",
  linkWidth: 1,
  linkWidthOf: () => 1,
  linkStroke: "#999999",
  linkColorOf: () => [153, 153, 153, 255],
  linkStrokeOf: () => "#999999",
  linkStyle: "line",
  arrowSize: 3,
  directed: false,
  sizeMode: "world",
  flowBorder: null,
  constBorder: null,
  linkBend: 0,
});

describe("resolveImportance", () => {
  it("defaults to the nodeRadius size metric (so the biggest glyph wins overlaps)", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], nodeFlow: new Float32Array([0.5, 0.25, 0.125]) });
    const imp = resolveImportance(g, undefined, { by: "flow", scale: (v) => v });
    expect(Array.from(imp)).toEqual([0.5, 0.25, 0.125]); // per-node flow (exact in Float32)
  });

  it("falls back to flat input order for a constant size", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2] });
    expect(Array.from(resolveImportance(g, undefined, 5))).toEqual([1, 1, 1]);
  });

  it("honours an explicit metric or per-node array", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2] }); // node 1 has degree 2
    expect(Array.from(resolveImportance(g, "degree", 5))).toEqual([1, 2, 1]);
    const custom = new Float32Array([9, 8, 7]);
    expect(resolveImportance(g, custom, 5)).toBe(custom); // used as-is, no copy
  });
});

describe("link colour {by,scale} parity", () => {
  it("resolves the {by,scale} form to per-weight CSS (Scene) and RGBA (WebGL)", () => {
    const scale = (w: number) => (w > 5 ? "#000000" : "#ffffff"); // a stand-in colour scale of the weight
    expect(resolveLinkStrokeOf({ by: "weight", scale })(10)).toBe("#000000");
    expect(Array.from(resolveLinkColorOf({ by: "weight", scale })(10))).toEqual([0, 0, 0, 255]);
    expect(Array.from(resolveLinkColorOf({ by: "weight", scale })(1))).toEqual([255, 255, 255, 255]);
  });

  it("still accepts a bare colour and a (weight)=>css function", () => {
    expect(resolveLinkStrokeOf("#abcdef")(99)).toBe("#abcdef");
    expect(resolveLinkStrokeOf((w) => (w > 1 ? "#111111" : "#eeeeee"))(2)).toBe("#111111");
  });
});

describe("nodeCircles", () => {
  it("shares both the positions buffer and the resolved radii buffer (no copies)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([10, 20, 30, 40]);
    const radii = new Float32Array([5, 9]);

    const c = nodeCircles(g, { radii, fill: "#ff0000" });

    expect(c.count).toBe(2);
    expect(c.centers).toBe(g.positions); // shares the buffer — no copy
    expect(c.radii).toBe(radii); // shares the resolved radii — no copy
    expect(Array.from(c.colors)).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
  });

  it("parses named/rgb colours and applies opacity to the alpha byte", () => {
    const g = buildGraph({ nodeCount: 1, source: [], target: [] });
    const c = nodeCircles(g, { radii: new Float32Array([3]), fill: "rgba(0, 128, 255, 0.5)" });

    expect(Array.from(c.colors)).toEqual([0, 128, 255, 128]);
  });
});

describe("linkLines", () => {
  it("gathers each edge's endpoints from node positions by index", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2] });
    g.positions.set([0, 0, 10, 10, 20, 20]); // nodes 0,1,2

    const l = linkLines(g, { widthOf: () => 2, colorOf: () => [0, 0, 0, 255] });

    expect(l.count).toBe(2);
    expect(Array.from(l.sources)).toEqual([0, 0, 10, 10]); // edge0 src=node0, edge1 src=node1
    expect(Array.from(l.targets)).toEqual([10, 10, 20, 20]); // edge0 tgt=node1, edge1 tgt=node2
    expect(Array.from(l.widths)).toEqual([2, 2]);
    expect(Array.from(l.colors)).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });
});

describe("linkArrows", () => {
  it("carries the target *centre* + the *target* node's radius (the tip sets back in-shader)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true });
    g.positions.set([0, 0, 10, 0]); // node0 at origin, node1 at (10,0)

    // node0 radius 5, node1 (the target) radius 2 → setback uses the target's 2, not the source's 5.
    const a = linkArrows(g, { size: 4, nodeRadii: new Float32Array([5, 2]), colorOf: () => [255, 0, 0, 255] });

    expect(a.count).toBe(1);
    expect(Array.from(a.sources)).toEqual([0, 0]);
    expect(Array.from(a.targets)).toEqual([10, 0]); // the target centre (setback is in-shader)
    expect(Array.from(a.radii)).toEqual([2]); // target radius → the shader sets the tip back to the boundary
    expect(Array.from(a.sizes)).toEqual([4]);
    expect(Array.from(a.colors)).toEqual([255, 0, 0, 255]);
  });
});

describe("networkLayers", () => {
  it("emits links then nodes for an undirected graph (no arrows)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const layers = networkLayers(g, { ...style(2), directed: false });

    expect(layers.map((l) => l.name)).toEqual(["links", "nodes"]);
    expect(layers.map((l) => l.primitive)).toEqual(["lines", "circles"]);
  });

  it("inserts arrows between links and nodes for a directed graph", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true });
    const layers = networkLayers(g, { ...style(2), directed: true });

    expect(layers.map((l) => l.name)).toEqual(["links", "arrows", "nodes"]);
    expect(layers.map((l) => l.primitive)).toEqual(["lines", "arrows", "circles"]);
  });

  it("emits only nodes when there are no edges", () => {
    const g = buildGraph({ nodeCount: 1, source: [], target: [] });
    const layers = networkLayers(g, { ...style(1), directed: true });

    expect(layers.map((l) => l.name)).toEqual(["nodes"]);
  });

  it("threads sizeMode to nodes, links, and arrowheads (the arrow shader honours it in-shader)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true });
    const layers = networkLayers(g, { ...style(2), directed: true, sizeMode: "screen" });

    const bySize = Object.fromEntries(layers.map((l) => [l.name, l.sizeMode]));
    expect(bySize).toEqual({ links: "screen", arrows: "screen", nodes: "screen" });
  });

  it("emits one fused half-arrow links layer (no separate arrows) for linkStyle:'half-arrow'", () => {
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 0], directed: true });
    const layers = networkLayers(g, { ...style(2), directed: true, linkStyle: "half-arrow", linkBend: 30 });

    // The arrowhead is part of the filled shape, so there is no "arrows" layer; world-sized.
    expect(layers.map((l) => l.name)).toEqual(["links", "nodes"]);
    expect(layers.map((l) => l.primitive)).toEqual(["half-arrows", "circles"]);
    expect(layers.find((l) => l.name === "links")?.sizeMode).toBe("world");
  });
});

describe("halfArrowLinks", () => {
  it("packs per-edge endpoints, [r0,r1] radii, and pairs reciprocal widths via oppositeWidth", () => {
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 0], weight: [5, 2], directed: true });
    g.positions.set([0, 0, 10, 0]);
    const d = halfArrowLinks(g, {
      nodeRadii: new Float32Array([3, 1]),
      widthOf: (w) => w, // width == weight, so we can read pairing directly
      colorOf: () => [1, 2, 3, 255],
      bend: 30,
    });

    expect(d.count).toBe(2);
    // edge 0 (0→1): r0=node0=3, r1=node1=1; edge 1 (1→0): r0=node1=1, r1=node0=3.
    expect(Array.from(d.radii)).toEqual([3, 1, 1, 3]);
    // widths = [width, oppositeWidth]: edge0 carries 5 with opposite 2; edge1 carries 2 with opposite 5.
    expect(Array.from(d.widths)).toEqual([5, 2, 2, 5]);
    expect(Array.from(d.bends)).toEqual([30, 30]);
    expect(Array.from(d.colors)).toEqual([1, 2, 3, 255, 1, 2, 3, 255]);
  });

  it("falls back oppositeWidth to the edge's own width when there is no reciprocal link", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], weight: [4], directed: true });
    const d = halfArrowLinks(g, { nodeRadii: new Float32Array([2, 2]), widthOf: (w) => w, colorOf: () => [0, 0, 0, 255], bend: 10 });
    expect(Array.from(d.widths)).toEqual([4, 4]); // no 1→0 edge ⇒ oppositeWidth = own width
  });
});

describe("noLodStyleCache highlight group columns (#214)", () => {
  // The #162 shader-highlight group columns are position-independent copies of the immutable edge
  // list, so they live on the #179 cache: built ONCE per (graph, style) version and reference-stable
  // across position-only frames — the invariant the renderer's reference-identity check needs to skip
  // their per-frame GPU upload. A fresh cache (data/style change) must hand back FRESH instances so
  // the changed columns DO upload.

  it("carries source ids, target ids (undirected incident hover), and the node-identity column", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2] });
    const c = noLodStyleCache(g, { ...style(3), directed: false });
    expect(Array.from(c.groupSource)).toEqual([0, 1]);
    expect(Array.from(c.groupTarget ?? [])).toEqual([1, 2]);
    expect(Array.from(c.nodeGroups)).toEqual([0, 1, 2]);
  });

  it("omits groupTarget when directed (links match on source alone) — including half-arrows", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });
    const c = noLodStyleCache(g, { ...style(3), directed: true });
    expect(c.kind).toBe("lines+arrows");
    expect(Array.from(c.groupSource)).toEqual([0, 1]);
    expect(c.groupTarget).toBeUndefined();
    const h = noLodStyleCache(g, { ...style(3), directed: true, linkStyle: "half-arrow" });
    expect(h.kind).toBe("half-arrows");
    expect(Array.from(h.groupSource)).toEqual([0, 1]);
    expect(h.groupTarget).toBeUndefined();
    expect(Array.from(h.nodeGroups)).toEqual([0, 1, 2]);
  });

  it("still carries the node column for an edgeless graph (lines-only kind)", () => {
    const g = buildGraph({ nodeCount: 2, source: [], target: [] });
    const c = noLodStyleCache(g, style(2));
    expect(c.kind).toBe("lines-only");
    expect(c.groupSource.length).toBe(0);
    expect(Array.from(c.nodeGroups)).toEqual([0, 1]);
  });

  it("columns are identity-stable across position-only frames, fresh per cache version", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2] });
    const s = { ...style(3), directed: false };
    const c = noLodStyleCache(g, s);
    const { groupSource, groupTarget, nodeGroups } = c;

    // Position-only frames rebuild layers from the SAME cache — the columns must be untouched, the
    // same array instances (reference-stable ⟺ upload skipped by the renderer's identity check).
    g.positions.set([5, 5, 15, 15, 25, 25]);
    networkLayersFromCache(g, s, c);
    g.positions.set([6, 6, 16, 16, 26, 26]);
    networkLayersFromCache(g, s, c);
    expect(c.groupSource).toBe(groupSource);
    expect(c.groupTarget).toBe(groupTarget);
    expect(c.nodeGroups).toBe(nodeGroups);

    // Invalidation: a fresh cache version (data/style change) allocates FRESH instances, so the new
    // columns are a new reference and DO upload.
    const c2 = noLodStyleCache(g, s);
    expect(c2.groupSource).not.toBe(groupSource);
    expect(c2.groupTarget).not.toBe(groupTarget);
    expect(c2.nodeGroups).not.toBe(nodeGroups);
    expect(Array.from(c2.groupSource)).toEqual(Array.from(groupSource)); // same content, new identity
  });
});

describe("networkLayersFromCache (#179 position-only frame)", () => {
  // The cache split must be output-identical to the full path: reusing the cached style attributes
  // and rebuilding only endpoints/centres from moved positions yields exactly what networkLayers would.
  function linkOf(layers: ReturnType<typeof networkLayers>) {
    const l = layers.find((x) => x.name === "links")!;
    return l.primitive === "lines" ? l.lines : l.primitive === "half-arrows" ? l.halfArrows : null;
  }

  it("undirected lines: cached path reuses style bytes, rebuilds endpoints from new positions", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], weight: [3, 7] });
    g.positions.set([0, 0, 10, 10, 20, 20]);
    const s = { ...style(3), directed: false, linkWidthOf: (w: number) => w, linkColorOf: (w: number) => [w, 0, 0, 255] as [number, number, number, number] };

    const full = networkLayers(g, s);
    const cache = noLodStyleCache(g, s);
    // Move node positions (a layout tick), then rebuild from the cache.
    g.positions.set([5, 5, 15, 15, 25, 25]);
    const cached = networkLayersFromCache(g, s, cache);
    const fullMoved = networkLayers(g, s); // ground truth at the new positions

    const cl = linkOf(cached)!;
    const fl = linkOf(fullMoved)!;
    expect(Array.from(cl.sources)).toEqual(Array.from(fl.sources)); // endpoints tracked the move
    expect(Array.from(cl.targets)).toEqual(Array.from(fl.targets));
    expect(Array.from(cl.widths)).toEqual(Array.from(fl.widths));    // style bytes identical
    expect(Array.from(cl.colors)).toEqual(Array.from(fl.colors));
    // And the cached style bytes match the ORIGINAL emit's (weight-derived, position-independent).
    expect(Array.from(cl.colors)).toEqual(Array.from(linkOf(full)!.colors));
  });

  it("directed half-arrows: cached path is output-identical to the full path at moved positions", () => {
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 0], weight: [5, 2], directed: true });
    g.positions.set([0, 0, 10, 0]);
    const s: ResolvedNetworkStyle = { ...style(2), directed: true, linkStyle: "half-arrow", linkBend: 30, linkWidthOf: (w) => w, linkColorOf: (w) => [w, 1, 2, 255] };

    const cache = noLodStyleCache(g, s);
    g.positions.set([2, 3, 12, 3]);
    const cached = networkLayersFromCache(g, s, cache);
    const full = networkLayers(g, s);

    const ch = linkOf(cached)!;
    const fh = linkOf(full)!;
    expect(Array.from(ch.sources)).toEqual(Array.from(fh.sources));
    expect(Array.from(ch.targets)).toEqual(Array.from(fh.targets));
    expect(Array.from((ch as { widths: Float32Array }).widths)).toEqual(Array.from((fh as { widths: Float32Array }).widths));
    expect(Array.from((ch as { radii: Float32Array }).radii)).toEqual(Array.from((fh as { radii: Float32Array }).radii));
    expect(Array.from(ch.colors)).toEqual(Array.from(fh.colors));
  });
});

describe("resolveNodeRadii", () => {
  // star: node 1 is the hub (degree 3, strength 6 via weights 1/2/3); leaves degree 1.
  const star = () => buildGraph({ nodeCount: 4, source: [0, 1, 1], target: [1, 2, 3], weight: [1, 2, 3] });

  it("fills a constant radius for a number", () => {
    expect(Array.from(resolveNodeRadii(star(), 7))).toEqual([7, 7, 7, 7]);
  });

  it("uses a supplied Float32Array as-is (no copy) and validates its length", () => {
    const g = star();
    const radii = new Float32Array([1, 2, 3, 4]);
    expect(resolveNodeRadii(g, radii)).toBe(radii);
    expect(() => resolveNodeRadii(g, new Float32Array([1, 2]))).toThrow(/length 2 !== nodeCount 4/);
  });

  it("passes the node's degree to a function accessor (a bare d3 scale fits here)", () => {
    const g = star();
    // degree-driven: radius = 2 * degree. Hub (deg 3) → 6; leaves (deg 1) → 2.
    const radii = resolveNodeRadii(g, (degree) => 2 * degree);
    expect(Array.from(radii)).toEqual([2, 6, 2, 2]);
  });

  it("scales by degree / strength / a custom metric via { by, scale }", () => {
    const g = star();
    const double = (v: number) => v * 2;
    expect(Array.from(resolveNodeRadii(g, { by: "degree", scale: double }))).toEqual([2, 6, 2, 2]);
    // strength = summed incident weights: node0=1, hub=1+2+3=6, node2=2, node3=3.
    expect(Array.from(resolveNodeRadii(g, { by: "strength", scale: double }))).toEqual([2, 12, 4, 6]);
    expect(Array.from(resolveNodeRadii(g, { by: (i) => i, scale: double }))).toEqual([0, 2, 4, 6]);
  });

  it("sizes by app-provided flow, and errors clearly when none was supplied", () => {
    const withFlow = buildGraph({ nodeCount: 4, source: [0, 1, 1], target: [1, 2, 3], nodeFlow: [0.1, 0.4, 0.2, 0.3] });
    const radii = resolveNodeRadii(withFlow, { by: "flow", scale: (v) => v * 10 });
    expect(Array.from(radii)).toEqual([1, 4, 2, 3]);
    expect(() => resolveNodeRadii(star(), { by: "flow", scale: (v) => v })).toThrow(/requires nodeFlow/);
  });
});

describe("pickNodes (#105 N7a — no-LOD full-graph hit-test)", () => {
  const positions = Float32Array.from([0, 0, 100, 0, 200, 0]);
  const radii = Float32Array.from([4, 4, 4]);
  const id = { k: 1, x: 0, y: 0 };

  it("resolves the node under the point, −1 on a miss", () => {
    expect(pickNodes(positions, radii, 3, 0, 0, id, false)).toBe(0);
    expect(pickNodes(positions, radii, 3, 100, 0, id, false)).toBe(1);
    expect(pickNodes(positions, radii, 3, 50, 0, id, false)).toBe(-1);
    expect(pickNodes(positions, radii, 3, 5, 0, id, false)).toBe(-1); // dist 5 > radius 4
  });

  it("applies the transform (world radius ×k) and the screenSized (constant px) modes", () => {
    const t = { k: 2, x: 0, y: 0 };
    expect(pickNodes(positions, radii, 3, 200, 0, t, false)).toBe(1); // node1 → screen 200, radius 8
    expect(pickNodes(positions, radii, 3, 207, 0, t, false)).toBe(1); // dist 7 < 8
    expect(pickNodes(positions, radii, 3, 209, 0, t, false)).toBe(-1); // dist 9 > 8
    expect(pickNodes(positions, radii, 3, 3, 0, t, true)).toBe(0); // screenSized: radius stays 4px
    expect(pickNodes(positions, radii, 3, 5, 0, t, true)).toBe(-1);
  });

  it("returns the topmost (last) node when circles overlap", () => {
    const p = Float32Array.from([0, 0, 2, 0]); // both radius 4 → overlap; (1,0) inside both
    expect(pickNodes(p, Float32Array.from([4, 4]), 2, 1, 0, id, false)).toBe(1);
  });
});
