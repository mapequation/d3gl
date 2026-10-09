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

// nodeRadius 3: a bottom module's three leaves overlap one another, so the cut keeps it collapsed until its
// footprint opens it (#426 opens an aggregate whose members' glyphs do not overlap, whatever its size).
const STYLE: NetworkStyle = { directed: true, linkStyle: "half-arrow", linkBend: 0.15, nodeRadius: 3, nodeFill: "#7f7f7f", linkWidth: 3, linkStroke: LINK };

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

interface ExportedCircle { fill: number[]; stroke: number[]; strokeWidth: number; r: number }

/** Every exported `<circle>` — fill and stroke as `[r, g, b, a]` (a 0-1; none ⇒ a 0), its stroke width and
 *  radius — in document order. */
function exportedCircles(svg: string): ExportedCircle[] {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const rgba = (s: string | null): number[] => {
    const v = (s?.match(/[\d.]+/g) ?? []).map(Number);
    return v.length >= 3 ? [v[0]!, v[1]!, v[2]!, v[3] ?? 1] : [0, 0, 0, 0];
  };
  return Array.from(doc.querySelectorAll("circle"), (c) => ({
    fill: rgba(c.getAttribute("fill")),
    stroke: rgba(c.getAttribute("stroke")),
    strokeWidth: Number(c.getAttribute("stroke-width") ?? 0),
    r: Number(c.getAttribute("r")),
  }));
}

const C1 = [44, 160, 44];
const C2 = [148, 103, 189];
const css = ([r, g, b]: number[]): string => `rgb(${r}, ${g}, ${b})`;
/** Module flow alone (`.ftree`-style, no per-node flow): every module but [2, 2] has a value. */
const MODULE_FLOW = new Map<string, number>([["1", 0.3], ["2", 0.6], ["1:1", 0.2], ["1:2", 0.4], ["2:1", 0.5]]);
const FLOW_STYLE: NetworkStyle = {
  ...STYLE,
  // Each top module in its own colour: its sub-modules, and the module itself, are filled with it.
  nodeFill: (i) => css(MODULES[i]!.path[0] === 1 ? C1 : C2),
  // World units, so a ring's exported stroke width is directly the flow ring's width.
  flowBorder: { scale: (v) => 10 * v, color: "#000000", moduleFlow: (path) => MODULE_FLOW.get(path.join(":")) },
};
/** Each module's enter flow, already through the app's ring scale (world units): the open module's ring
 *  width. [2, 2] has none — the constant default. */
const ENTER_WIDTH = new Map<string, number>([["1", 2.5], ["2", 5], ["1:1", 1.5], ["1:2", 3.5], ["2:1", 4.5]]);
const FLOW_RINGS: NetworkLODOptions = {
  ...OPEN_TOP,
  moduleBoundary: { width: (path) => ENTER_WIDTH.get(path.join(":")), color: "fill", opacity: 1 },
  aggregateOutline: false,
};
const near = (a: number[], b: number[]): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= 1);
/** The open modules' rings (a transparent fill, a stroke), as `[stroke rgb, width]`, sorted by width. */
const ringsOf = (svg: string): [number[], number][] =>
  exportedCircles(svg)
    .filter((c) => c.fill[3] === 0 && c.strokeWidth > 0)
    .map((c): [number[], number] => [c.stroke.slice(0, 3), c.strokeWidth])
    .sort((a, b) => a[1] - b[1]);

describe("module boundaries in the module's own fill and width (#471)", () => {
  for (const backend of BACKENDS) {
    it(`${backend}: each open module's ring in its collapsed fill and its own width; module flow alone rings modules only`, async () => {
      const net = await engine(backend, FLOW_RINGS, K_TOP, FLOW_STYLE);
      // k = 4: the top modules are open, their sub-modules collapsed.
      const top = net.toSVG();
      const tops = ringsOf(top);
      expect(tops.map(([, w]) => w)).toEqual([expect.closeTo(2.5, 4), expect.closeTo(5, 4)]); // width([1]), width([2])
      // The collapsed sub-modules: filled in their colour and ringed (in the flow border's black) by their
      // own `moduleFlow` value — none for [2, 2], which has none.
      const collapsed = exportedCircles(top).filter((c) => c.fill[3] > 0);
      const glyphs = collapsed.map((c): [number[], number] => [c.fill.slice(0, 3), c.strokeWidth]).sort((a, b) => a[1] - b[1]);
      expect(glyphs.map(([, w]) => Number(w.toFixed(3)))).toEqual([0, 2, 4, 5]); // scale(0.2 | 0.4 | 0.5), none
      // Each ring is in the fill its collapsed module was drawn with.
      for (const [color, w] of tops) {
        const fill = w < 3 ? C1 : C2;
        expect(near(color, fill), `ring ${w}: ${color} vs ${fill}`).toBe(true);
      }
      expect(glyphs.filter(([c]) => near(c, C1)).length).toBe(2); // ...the same fill as its sub-modules'
      // k = 12: the sub-modules open, each ring in its fill and its own width (the default 1 for [2, 2]).
      net.setTransform({ k: 12, x: W / 2, y: H / 2 });
      net.syncScreenGeometry();
      const want = new Map<number, number[]>([[1.5, C1], [3.5, C1], [4.5, C2], [1, C2]]);
      const deep = ringsOf(net.toSVG()).filter(([, w]) => Math.abs(w - 2.5) > 1e-3 && Math.abs(w - 5) > 1e-3);
      expect(deep.length, JSON.stringify(deep)).toBeGreaterThan(0);
      for (const [color, w] of deep) {
        const key = [...want.keys()].find((k) => Math.abs(k - w) < 1e-3);
        expect(key, `unexpected ring width ${w}`).toBeDefined();
        expect(near(color, want.get(key ?? -1) ?? []), `ring ${w}: ${color}`).toBe(true);
      }
      // No leaf has a ring: `flow` is omitted, so no node has a value.
      const leaves = exportedCircles(net.toSVG()).filter((c) => c.fill[3] > 0 && Math.abs(c.r - 3) < 0.01);
      expect(leaves.length).toBeGreaterThan(0);
      expect(leaves.every((c) => c.strokeWidth === 0), JSON.stringify(leaves.slice(0, 3))).toBe(true);
      net.destroy();
    });
  }

  it("a module the width accessor gives none takes the constant default; the outline keeps its default line", async () => {
    for (const backend of BACKENDS) {
      const net = await engine(backend, { ...OPEN_TOP, moduleBoundary: { width: () => undefined, color: "fill", opacity: 1 } }, K_TOP, FLOW_STYLE);
      const rings = ringsOf(net.toSVG());
      const open = rings.filter(([c]) => near(c, C1) || near(c, C2));
      expect(open.map(([, w]) => w), backend).toEqual([expect.closeTo(1, 5), expect.closeTo(1, 5)]);
      // The collapsed sub-modules' outline: the default line (1, a dark neutral), not "fill" or the accessor.
      expect(rings.filter(([c]) => near(c, [58, 63, 82])).length, backend).toBeGreaterThan(0);
      net.destroy();
    }
  });

  it("draws the rings above every link and below every node — the same order on every backend", async () => {
    const order: string[] = [];
    for (const backend of BACKENDS) {
      const net = await engine(backend, { ...OPEN_TOP, crossLevelEdges: true, moduleBoundary: { width: 2, color: RING, opacity: 1 }, aggregateOutline: false }, K_TOP);
      const doc = new DOMParser().parseFromString(net.toSVG(), "image/svg+xml");
      const kinds: string[] = [];
      const linkRGB = "31, 78, 153";
      for (const el of Array.from(doc.querySelectorAll("path, circle, line, polygon"))) {
        const fill = el.getAttribute("fill") ?? "";
        const stroke = el.getAttribute("stroke") ?? "";
        if (fill.includes(linkRGB) || stroke.includes(linkRGB)) kinds.push("link");
        else if (stroke.includes("214, 39, 40")) kinds.push("ring");
        else if (fill.includes("127, 127, 127")) kinds.push("node");
      }
      const first = (k: string): number => kinds.indexOf(k);
      const last = (k: string): number => kinds.lastIndexOf(k);
      expect(first("link"), `${backend}: links drawn`).toBeGreaterThanOrEqual(0);
      expect(first("ring"), `${backend}: rings drawn`).toBeGreaterThanOrEqual(0);
      expect(first("node"), `${backend}: nodes drawn`).toBeGreaterThanOrEqual(0);
      order.push(`${backend}: ${last("link") < first("ring") && last("ring") < first("node") ? "links < rings < nodes" : kinds.join(",")}`);
      net.destroy();
    }
    expect(order).toEqual(BACKENDS.map((b) => `${b}: links < rings < nodes`));
  });

  for (const sizeMode of ["world", "screen"] as const) {
    for (const k of [K_TOP, 12]) {
      it(`exports identically from WebGL and Canvas: ${sizeMode} sizeMode, k=${k}`, async () => {
        const style = { ...FLOW_STYLE, sizeMode };
        const svgs: string[] = [];
        for (const backend of ["webgl", "canvas"] as const) {
          const net = await engine(backend, { ...FLOW_RINGS, crossLevelEdges: true }, k, style);
          svgs.push(net.toSVG());
          net.destroy();
        }
        expect(ringsOf(svgs[0]!).length).toBeGreaterThan(0);
        const d = await diffExports(svgs[0]!, svgs[1]!, W, H, { radius: 1 });
        expect(d.considered).toBeGreaterThan(1500);
        expect(d.fraction).toBeLessThan(CEILING);
      });
    }
  }
});
