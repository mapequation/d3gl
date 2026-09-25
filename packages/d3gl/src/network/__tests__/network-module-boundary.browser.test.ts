import { describe, it, expect } from "vitest";
import { network, type Network, type NetworkLODOptions, type NetworkStyle } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleLink, ModuleNode } from "../modules.js";
import { diffExports } from "../../map/__tests__/backend-equivalence-harness.js";

/**
 * Module boundaries (#329) through the engine, on every backend: `lod({ moduleBoundary })` rings each
 * expanded module in view, and with `crossLevelEdges` a module link whose endpoint is expanded is drawn
 * from that module's ring. The ring count and the anchored links are compared across WebGL, Canvas and
 * SVG through `toSVG()` (the typed probe of what each path emitted), and the WebGL export is pixel-diffed
 * against the Canvas one (#271 harness) at two zooms, in world and screen sizeMode.
 */

const W = 360;
const H = 360;
const BACKENDS = ["webgl", "canvas", "svg"] as const;
const RING = "#d62728";
const LINK = "#1f4e99";

/**
 * An `.ftree`-shaped map: top modules 1 and 2, each with sub-modules x:1 and x:2 of three leaves. Graph
 * edges only between leaves of one bottom module; every coarser link is a module link.
 */
const MODULES: ModuleNode[] = [];
for (let t = 1; t <= 2; t++) for (let s = 1; s <= 2; s++) for (let l = 1; l <= 3; l++) MODULES.push({ id: MODULES.length, path: [t, s, l] });
const LINKS: ModuleLink[] = [
  { source: [1], target: [2], flow: 5 },
  { source: [2], target: [1], flow: 3 },
  { source: [1, 1], target: [1, 2], flow: 2 },
  { source: [2, 1], target: [2, 2], flow: 1 },
];

function graph(): NetworkGraph {
  const source: number[] = [];
  const target: number[] = [];
  for (let m = 0; m < 4; m++) for (let l = 0; l < 2; l++) {
    source.push(m * 3 + l);
    target.push(m * 3 + l + 1);
  }
  return buildGraph({ nodeCount: 12, source, target, weight: source.map(() => 1), directed: true });
}

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

/** Occurrences of a stroke / fill colour in an exported document (both paths serialize `rgba(r, g, b, a)`). */
function uses(svg: string, attr: "stroke" | "fill", css: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16));
  return (svg.match(new RegExp(`${attr}="rgba\\(${r}, ?${g}, ?${b}`, "g")) ?? []).length;
}

const STYLE: NetworkStyle = { directed: true, linkStyle: "half-arrow", linkBend: 0.15, nodeRadius: 1.5, nodeFill: "#7f7f7f", linkWidth: 3, linkStroke: LINK };

/** A laid-out engine (the nested layout, synchronously) at zoom `k` about the map's centre. */
async function engine(backend: (typeof BACKENDS)[number], lod: NetworkLODOptions, k: number, style: NetworkStyle = STYLE): Promise<Network> {
  const net = network(host(), { width: W, height: H, backend });
  await net.whenReady();
  net.data(graph(), { modules: MODULES, moduleLinks: LINKS }).style(style).lod(lod).layout({ backend: "force", nested: true });
  // The nested root disc is centred on the origin with radius 10·√12 ≈ 35: frame it at k about (0, 0).
  net.setTransform({ k, x: W / 2, y: H / 2 });
  net.syncScreenGeometry();
  return net;
}

// k = 4: the top modules (discs ~24 across → ~100 px) open, their sub-modules (~40 px) stay collapsed.
const OPEN_TOP: NetworkLODOptions = { expandPx: 60, declutter: false };
const K_TOP = 4;

describe("module boundaries on every backend (#329)", () => {
  it("rings each expanded module in view — the same set on WebGL, Canvas and SVG, none when off", async () => {
    const counts: number[] = [];
    for (const backend of BACKENDS) {
      // aggregateOutline: false — count the expanded modules' rings alone, not the collapsed ones' default outline.
      const net = await engine(backend, { ...OPEN_TOP, moduleBoundary: { width: 1.5, color: RING, opacity: 1 }, aggregateOutline: false }, K_TOP);
      counts.push(uses(net.toSVG(), "stroke", RING));
      net.lod({ ...OPEN_TOP }); // option off
      net.syncScreenGeometry();
      expect(uses(net.toSVG(), "stroke", RING), `${backend}: rings without the option`).toBe(0);
      net.destroy();
    }
    expect(counts).toEqual([2, 2, 2]); // modules 1 and 2 (never the root: the whole network)
  });

  it("outlines the collapsed modules with the same line by default — the same set on every backend", async () => {
    const counts: number[] = [];
    for (const backend of BACKENDS) {
      const withOutline = await engine(backend, { ...OPEN_TOP, moduleBoundary: { width: 1.5, color: RING, opacity: 1 } }, K_TOP);
      const total = uses(withOutline.toSVG(), "stroke", RING);
      withOutline.destroy();
      const ringsOnly = await engine(backend, { ...OPEN_TOP, moduleBoundary: { width: 1.5, color: RING, opacity: 1 }, aggregateOutline: false }, K_TOP);
      counts.push(total - uses(ringsOnly.toSVG(), "stroke", RING));
      ringsOnly.destroy();
    }
    expect(counts[0]).toBeGreaterThan(0); // the visible collapsed sub-modules
    expect(new Set(counts).size).toBe(1);
  });

  it("never picks a ring on any backend — it is decoration, like the WebGL lane's", async () => {
    for (const backend of BACKENDS) {
      // With the collapsed modules' default outline too: neither ring layer is pickable.
      const net = await engine(backend, { ...OPEN_TOP, moduleBoundary: { width: 1.5, color: RING, opacity: 1 } }, K_TOP);
      expect(uses(net.toSVG(), "stroke", RING), `${backend}: rings drawn`).toBeGreaterThan(2);
      const layers = new Map<string, number>();
      for (let y = 10; y < H; y += 20) {
        for (let x = 10; x < W; x += 20) {
          const layer = net.pick(x, y)?.layer ?? "none";
          layers.set(layer, (layers.get(layer) ?? 0) + 1);
        }
      }
      expect(layers.get("module-boundaries"), `${backend}: ${JSON.stringify([...layers])}`).toBeUndefined();
      expect(layers.get("node-halos"), `${backend}: ${JSON.stringify([...layers])}`).toBeUndefined();
      net.destroy();
    }
  });

  it("rings deeper modules as they open on zoom", async () => {
    for (const backend of BACKENDS) {
      const net = await engine(backend, { ...OPEN_TOP, moduleBoundary: { color: RING, opacity: 1 } }, 12);
      expect(uses(net.toSVG(), "stroke", RING), backend).toBeGreaterThan(2);
      net.destroy();
    }
  });

  it("draws a module link from an expanded module's ring with cross-level edges on — and loses it without", async () => {
    const lods: [string, NetworkLODOptions, number][] = [
      ["boundary + cross-level", { ...OPEN_TOP, crossLevelEdges: true, moduleBoundary: { color: RING } }, 4],
      ["cross-level only", { ...OPEN_TOP, crossLevelEdges: true }, 2],
      ["boundary only", { ...OPEN_TOP, moduleBoundary: { color: RING } }, 2],
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const [label, lod, links] of lods) {
      for (const backend of BACKENDS) {
        const net = await engine(backend, lod, K_TOP);
        // Sub-module links 1:1→1:2 and 2:1→2:2 always; the top-level pair 1↔2 only anchored on the rings.
        got.push(`${label} on ${backend}: ${uses(net.toSVG(), "fill", LINK)}`);
        want.push(`${label} on ${backend}: ${links}`);
        net.destroy();
      }
    }
    expect(got).toEqual(want);
  });
});

/** The exported ring circles' radii (WebGL exports each ring as one stroked `<circle>`), sorted. */
function ringRadii(svg: string): number[] {
  const out: number[] = [];
  for (const m of svg.matchAll(/<circle [^>]*r="([^"]+)"[^>]*stroke="rgba\(214, 39, 40/g)) out.push(Number(m[1]));
  return out.sort((a, b) => a - b);
}

describe("module boundaries follow the nested layout's discs (#329)", () => {
  it("uses the same discs whether the nested layout ran on the worker or the main thread; other layouts fall back", async () => {
    const lod: NetworkLODOptions = { ...OPEN_TOP, moduleBoundary: { color: RING, opacity: 1 }, aggregateOutline: false };
    const radii = async (layout: (net: Network) => Promise<void>): Promise<number[]> => {
      const net = network(host(), { width: W, height: H, backend: "webgl" });
      await net.whenReady();
      net.data(graph(), { modules: MODULES, moduleLinks: LINKS }).style(STYLE).lod(lod);
      await layout(net);
      net.setTransform({ k: K_TOP, x: W / 2, y: H / 2 });
      const r = ringRadii(net.toSVG());
      net.destroy();
      return r;
    };
    const main = await radii(async (net) => void net.layout({ backend: "force", nested: true }));
    const worker = await radii(async (net) => {
      net.layout({ backend: "worker", nested: true });
      await net.whenSettled();
    });
    expect(main).toHaveLength(2);
    expect(worker).toHaveLength(2);
    for (let i = 0; i < 2; i++) expect(worker[i]).toBeCloseTo(main[i]!, 3);
    // The same positions supplied directly: no nested discs any more — the rings fall back to the extent.
    let positions = new Float32Array();
    const direct = await radii(async (net) => {
      const probe = network(host(), { width: W, height: H, backend: "canvas" });
      await probe.whenReady();
      const g = graph();
      probe.data(g, { modules: MODULES, moduleLinks: LINKS }).layout({ backend: "force", nested: true }); // the very same layout
      positions = g.positions.slice();
      probe.destroy();
      net.layout({ backend: "positions", positions });
    });
    expect(direct).toHaveLength(2);
    expect(direct[0]).not.toBeCloseTo(main[0]!, 1);
    expect(direct[1]!).toBeLessThan(main[1]!); // the members' extent sits inside their disc
  });
});

/** Ceiling on the mismatching share of exported ink (the #271 harness measures 0 on its own cases). */
const CEILING = 0.005;

describe("module boundaries export identically from WebGL and Canvas (#329, #271 harness)", () => {
  for (const sizeMode of ["world", "screen"] as const) {
    for (const k of [K_TOP, 7]) {
      it(`${sizeMode} sizeMode, k=${k}: rings + anchored links`, async () => {
        const lod: NetworkLODOptions = { ...OPEN_TOP, crossLevelEdges: true, moduleBoundary: { width: 2, color: RING, opacity: 0.8 } };
        const style = { ...STYLE, sizeMode };
        const svgs: string[] = [];
        for (const backend of ["webgl", "canvas"] as const) {
          const net = await engine(backend, lod, k, style);
          svgs.push(net.toSVG());
          net.destroy();
        }
        expect(uses(svgs[0]!, "stroke", RING)).toBeGreaterThan(0);
        const d = await diffExports(svgs[0]!, svgs[1]!, W, H, { radius: 1 });
        expect(d.considered).toBeGreaterThan(1500);
        expect(d.fraction).toBeLessThan(CEILING);
      });
    }
  }

  it("the rings are real ink: with them off the export differs", async () => {
    const svgs: string[] = [];
    for (const moduleBoundary of [{ width: 2, color: RING, opacity: 1 }, undefined]) {
      const net = await engine("webgl", { ...OPEN_TOP, moduleBoundary }, K_TOP);
      svgs.push(net.toSVG());
      net.destroy();
    }
    const d = await diffExports(svgs[0]!, svgs[1]!, W, H, { radius: 1 });
    expect(d.fraction).toBeGreaterThan(0.02);
  });
});
