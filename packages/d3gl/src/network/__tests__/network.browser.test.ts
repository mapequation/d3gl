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

// Pixel-level rendering of each primitive is covered (typed) at the backend layer in
// webgl/__tests__/instanced.browser.test.ts; layer assembly is covered (typed) by the
// networkLayers unit tests. These tests cover the engine's integration: mounting, the
// chainable API, and that data/style/layout drive a real backend without throwing.
describe("network() engine", () => {
  it("mounts on the default (webgl) backend and resolves whenReady", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    expect(typeof net.render).toBe("function");
    net.destroy();
  });

  it("pushes a directed graph through the lane without throwing, chainably", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });

    expect(net.data(g)).toBe(net);
    expect(net.style({ directed: true, linkWidth: 2 })).toBe(net);
    expect(net.layout({ backend: "positions", positions: new Float32Array([10, 10, 90, 90, 170, 30]) })).toBe(net);

    net.destroy();
  });

  it("renders a network to SVG on the svg backend (publication export)", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });
    net
      .data(g)
      .style({ directed: true, nodeRadius: 5, nodeFill: "#ff0000", linkStroke: "#999999", linkWidth: 1 })
      .layout({ backend: "positions", positions: new Float32Array([20, 20, 100, 100, 180, 40]) });

    const svg = net.toSVG();
    expect((svg.match(/<circle/g) ?? []).length).toBe(3); // one circle per node
    expect(svg).toContain("<path"); // links + arrowheads emitted as paths

    net.destroy();
  });

  it("sizes nodes by degree through the full style→export path", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    // star: node 0 is the hub (degree 3); nodes 1/2/3 are leaves (degree 1).
    const g = buildGraph({ nodeCount: 4, source: [0, 0, 0], target: [1, 2, 3], directed: true });
    net
      .data(g)
      .style({ nodeRadius: { by: "degree", scale: (d) => d } }) // radius == degree
      .layout({ backend: "positions", positions: new Float32Array([100, 100, 20, 20, 180, 20, 100, 180]) });

    const radii = [...net.toSVG().matchAll(/<circle[^>]*\br="([\d.eE+-]+)"/g)].map((m) => Number(m[1]));
    expect(radii.length).toBe(4);
    expect(new Set(radii)).toEqual(new Set([3, 1])); // hub radius 3, leaves radius 1

    net.destroy();
  });

  it("auto-positions an unpositioned graph with the force backend", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 8, source: [0, 1, 2, 3], target: [1, 2, 3, 0] });

    net.data(g).layout({ backend: "force", iterations: 50 });

    const svg = net.toSVG();
    const cxs = [...svg.matchAll(/<circle cx="([\d.eE+-]+)"/g)].map((m) => Number(m[1]));
    expect(cxs.length).toBe(8);
    expect(new Set(cxs).size).toBeGreaterThan(1); // nodes spread out, not all stacked

    net.destroy();
  });

  it("drives the LOD cut through layout, enable, and zoom on the WebGL lane without throwing", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    // A ring of 40 nodes (coarsens to several levels) with supplied positions ⇒ settled at once.
    const N = 40;
    const source: number[] = [];
    const target: number[] = [];
    const positions = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      source.push(i);
      target.push((i + 1) % N);
      const a = (i / N) * Math.PI * 2;
      positions[i * 2] = 100 + 80 * Math.cos(a);
      positions[i * 2 + 1] = 100 + 80 * Math.sin(a);
    }
    const g = buildGraph({ nodeCount: N, source, target });

    net
      .data(g)
      .layout({ backend: "positions", positions })
      .lod({ expandPx: 48, coarsen: { minNodes: 2 } });

    // Re-cut across a wide zoom range: collapsed aggregates when out, individual leaves when in.
    expect(net.setTransform({ k: 0.05, x: 100, y: 100 })).toBe(net);
    expect(net.setTransform({ k: 20, x: -1900, y: -1900 })).toBe(net);
    // Disabling LOD restores the full-graph draw.
    expect(net.lod(false)).toBe(net);

    net.destroy();
  });

  it("drives the LOD cut from a provided module hierarchy (N6) across layout order and zoom", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    // Two modules of two nodes each, bridged — Infomap JSON node shape (id + path).
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2] });
    const modules = [
      { id: 0, path: [1, 1], flow: 0.25 },
      { id: 1, path: [1, 2], flow: 0.25 },
      { id: 2, path: [2, 1], flow: 0.25 },
      { id: 3, path: [2, 2], flow: 0.25 },
    ];

    net
      .data(g)
      .style({ sizeMode: "screen" })
      .lod({ modules, expandPx: 48 })
      .layout({ backend: "positions", positions: new Float32Array([10, 10, 30, 10, 170, 190, 190, 190]) });

    // The provided hierarchy — not coarsening — drives LOD.
    expect(net.lodSource).toBe("modules");
    // Re-cut across zoom: modules collapse when out, expand to leaves when in — no throw.
    expect(net.setTransform({ k: 0.1, x: 100, y: 100 })).toBe(net);
    expect(net.setTransform({ k: 30, x: -2900, y: -2900 })).toBe(net);

    net.destroy();
  });

  it("renders flow-border nodes (N6b) through the WebGL lane + LOD without throwing", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], nodeFlow: [0.4, 0.1, 0.3, 0.2] });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net
      .data(g)
      .style({
        sizeMode: "screen",
        nodeRadius: 10,
        flowBorder: { flow: "strength", scale: (v) => v, color: "#123456" },
      })
      .lod({ modules, expandPx: 48 })
      .layout({ backend: "positions", positions: new Float32Array([10, 10, 30, 10, 170, 190, 190, 190]) });

    expect(net.lodSource).toBe("modules");
    // Module aggregates sum their members' border metric (no throw through the frontier glyph).
    expect(net.setTransform({ k: 0.1, x: 100, y: 100 })).toBe(net);
    expect(net.setTransform({ k: 30, x: -2900, y: -2900 })).toBe(net);
    net.destroy();
  });

  it("exports a flow border to SVG as a border disc under a smaller fill disc (two circles per node)", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2] });
    net
      .data(g)
      .style({
        nodeRadius: 10,
        nodeFill: "#4878d0",
        flowBorder: { flow: new Float32Array([4, 4, 4]), scale: (v) => v, color: "#123456" },
      })
      .layout({ backend: "positions", positions: new Float32Array([20, 20, 100, 100, 180, 40]) });

    const svg = net.toSVG();
    // One border disc + one fill disc per node = 6 circles (vs 3 with no flow border).
    expect((svg.match(/<circle/g) ?? []).length).toBe(6);

    // Disabling the border returns to 3 circles (the node-borders layer clears, not lingers).
    net.style({ flowBorder: undefined });
    expect((net.toSVG().match(/<circle/g) ?? []).length).toBe(3);

    net.destroy();
  });

  it("renders bent half-arrow links (N6c) through the WebGL lane without throwing", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1, 2], target: [1, 2, 0], directed: true });
    // A bent directed cycle: the multi-sample bezier strip + one-sided half-arrow shaders must
    // compile and draw (a shader-link failure would throw here).
    expect(
      net
        .data(g)
        .style({ directed: true, linkBend: 0.2, linkWidth: 2 })
        .layout({ backend: "positions", positions: new Float32Array([40, 40, 160, 40, 100, 160]) }),
    ).toBe(net);
    net.destroy();
  });

  it("renders half-arrow links (N6) through the WebGL lane without throwing", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    // Reciprocal directed pair — the half-arrow shader must compile and draw both nested arrows.
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 0], weight: [0.5, 0.3], directed: true, nodeFlow: [0.6, 0.4] });
    expect(
      net
        .data(g)
        .style({
          directed: true,
          linkStyle: "half-arrow",
          nodeRadius: { by: "flow", scale: (f) => 20 + f * 20 },
          linkBend: 30,
          linkWidth: (w) => 7 + w * 12,
          linkStroke: (w) => (w > 0.4 ? "#418EC7" : "#71B2D7"),
          flowBorder: { flow: new Float32Array([6, 3]), scale: (v) => v, color: (_v, i) => (i === 0 ? "#f9a327" : "#FFAE38") },
        })
        .layout({ backend: "positions", positions: new Float32Array([50, 50, 150, 90]) }),
    ).toBe(net);
    net.destroy();
  });

  it("renders screen-sizeMode half-arrows across a zoom range without throwing (constant-px decorations)", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 0], weight: [0.5, 0.3], directed: true, nodeFlow: [0.6, 0.4] });
    net
      .data(g)
      .style({
        directed: true,
        linkStyle: "half-arrow",
        sizeMode: "screen", // half-arrow VS projects both centres to px and builds the shape in px
        nodeRadius: new Float32Array([30, 20]),
        linkBend: 30,
        linkWidth: (w) => (w > 0.4 ? 13 : 7),
        linkStroke: (w) => (w > 0.4 ? "#418EC7" : "#71B2D7"),
      })
      .layout({ backend: "positions", positions: new Float32Array([60, 60, 140, 100]) });
    // The screen branch (worldToPx + px→clip) must hold across non-trivial zooms (k≠1, where screen
    // and world diverge) — a shader-link or NaN failure would throw here.
    expect(net.setTransform({ k: 0.4, x: 80, y: 80 })).toBe(net);
    expect(net.setTransform({ k: 3, x: -200, y: -150 })).toBe(net);
    net.destroy();
  });

  it("exports half-arrow links to SVG as one filled path per link (head fused, no separate arrow)", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 0], weight: [0.5, 0.3], directed: true, nodeFlow: [0.6, 0.4] });
    net
      .data(g)
      .style({
        directed: true,
        linkStyle: "half-arrow",
        nodeRadius: new Float32Array([30, 20]),
        nodeFill: (i) => (i === 0 ? "#D75908" : "#EF7518"),
        linkBend: 30,
        linkWidth: (w) => (w > 0.4 ? 13 : 7),
        linkStroke: (w) => (w > 0.4 ? "#418EC7" : "#71B2D7"),
      })
      .layout({ backend: "positions", positions: new Float32Array([100, 100, 300, 180]) });

    const svg = net.toSVG();
    // Exactly one filled half-arrow path per directed link — the head is fused in, so there are no
    // separate arrowhead triangles (two links ⇒ two paths). The strip pinches to the source centre
    // (the backend flattens the bezier to a polyline and writes compact "L100,100").
    expect((svg.match(/<path/g) ?? []).length).toBe(2);
    expect(svg).toContain("L100,100"); // 0→1 link pinches to node 0's centre (100,100)
    expect((svg.match(/<circle/g) ?? []).length).toBe(2); // two plain nodes (no flow border here)
    // Each path is coloured by its own link flow (the two reference blues) — per-edge linkStroke.
    expect(svg).toContain("rgba(65, 142, 199"); // heavy 0→1
    expect(svg).toContain("rgba(113, 178, 215"); // light 1→0

    net.destroy();
  });

  it("exports bent links to SVG as flattened curved paths (vs straight)", async () => {
    const net = network(host(), { width: 200, height: 200, backend: "svg" });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1, 2], target: [1, 2, 0], directed: true });
    net
      .data(g)
      .style({ directed: true, linkBend: 0.25, nodeRadius: 6 })
      .layout({ backend: "positions", positions: new Float32Array([40, 40, 160, 40, 100, 160]) });
    const bent = net.toSVG();
    expect((bent.match(/<circle/g) ?? []).length).toBe(3);
    expect(bent).toContain("<path");

    // A bent link's path is a flattened bezier (many points); straightening shrinks the markup.
    net.style({ linkBend: 0 });
    expect(bent.length).toBeGreaterThan(net.toSVG().length);

    net.destroy();
  });

  it("renders a directed map of modules (N6c.2): flow borders + bent half-arrow super-edges", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    // Two modules of two nodes, with directed cross-module edges (so module super-edges exist).
    const g = buildGraph({
      nodeCount: 4,
      source: [0, 1, 0, 2],
      target: [1, 0, 2, 3],
      weight: [5, 5, 1, 5],
      directed: true,
      nodeFlow: [0.3, 0.3, 0.2, 0.2],
    });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net
      .data(g)
      .style({
        directed: true,
        sizeMode: "screen",
        linkBend: 0.2,
        flowBorder: { flow: "strength", scale: (v) => v * 0.5, color: "#234" },
      })
      .lod({ modules, expandPx: 48 })
      .layout({ backend: "positions", positions: new Float32Array([20, 20, 40, 20, 170, 180, 190, 180]) });

    expect(net.lodSource).toBe("modules");
    // Across zoom: collapsed modules show bent half-arrow super-edges; zoomed in, leaf links. No throw.
    expect(net.setTransform({ k: 0.4, x: 100, y: 100 })).toBe(net);
    expect(net.setTransform({ k: 30, x: -2900, y: -2900 })).toBe(net);
    net.destroy();
  });

  it("re-renders with a different-size graph + module hierarchy without throwing (depth change)", async () => {
    const net = network(host(), { width: 200, height: 200 });
    await net.whenReady();
    // The example's chain: data → style (per-node colour accessor) → lod(modules) → layout. style()
    // must not build a stale module tree against the new graph before lod() supplies fresh modules.
    const render = (n: number, modules: { id: number; path: number[] }[]) => {
      const source: number[] = [];
      const target: number[] = [];
      for (let i = 0; i + 1 < n; i++) (source.push(i), target.push(i + 1));
      net
        .data(buildGraph({ nodeCount: n, source, target }))
        .style({ sizeMode: "screen", nodeRadius: 4, nodeFill: (i) => (i % 2 ? "#f00" : "#00f") })
        .lod({ modules, expandPx: 40 })
        .layout({ backend: "positions", positions: new Float32Array(n * 2) });
    };
    const four = [{ id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] }];
    const six = [0, 1, 2, 3, 4, 5].map((id) => ({ id, path: [id < 3 ? 1 : 2, (id % 3) + 1] }));
    expect(() => render(4, four)).not.toThrow();
    expect(() => render(6, six)).not.toThrow(); // increase
    expect(() => render(4, four)).not.toThrow(); // decrease
    net.destroy();
  });
});
