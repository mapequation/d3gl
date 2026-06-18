import { schemeCategory10 } from "d3-scale-chromatic";
import { scaleOrdinal, scaleSqrt } from "d3-scale";
import { link as d3link, linkRadial, curveLinear, curveStepBefore, curveBumpX, pointRadial } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot, h } from "@mapequation/d3gl/map";
import { LabelLayer, type LabelAnchor } from "@mapequation/d3gl/labels";
import type { ImperativeSetup } from "../types.js";
import type { TreeNode } from "../shared/tree.js";
import { layoutRectangular, layoutRadial, nodeXY, type LayoutMode } from "../shared/layout.js";
import { makeMammalTree, assignBioregions, REGION_NAMES } from "../shared/mammals-data.js";
import { calcMaximumParsimony, aggregateClusters, aggregateSpeciesCount } from "../shared/parsimony.js";

const LINE_MIN = 1, LINE_MAX = 22; // branch-width range when scaling by subtended terminals

type SizeMode = "world" | "screen";
type CurveMode = "linear" | "step" | "bump";
type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

const regionColor = scaleOrdinal<number, string>()
  .domain(REGION_NAMES.map((_, i) => i))
  .range(schemeCategory10 as string[]);

interface Wedge { cx: number; cy: number; r: number; a0: number; a1: number; clusterId: number; count: number; single: boolean; node: PNode; }
interface PieSpec { cx: number; cy: number; rBase: number; node: PNode; slices: { clusterId: number; count: number; a0: number; a1: number }[]; }

/** Wrap a canvas-like context so every path call is shifted by (ox, oy). Used for radial
 *  generators (linkRadial) that emit coordinates around the origin. */
function offsetCtx(ctx: CanvasRenderingContext2D, ox: number, oy: number): CanvasRenderingContext2D {
  return {
    beginPath: () => ctx.beginPath(),
    closePath: () => ctx.closePath(),
    moveTo: (x: number, y: number) => ctx.moveTo(x + ox, y + oy),
    lineTo: (x: number, y: number) => ctx.lineTo(x + ox, y + oy),
    quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => ctx.quadraticCurveTo(cx + ox, cy + oy, x + ox, y + oy),
    bezierCurveTo: (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) =>
      ctx.bezierCurveTo(c1x + ox, c1y + oy, c2x + ox, c2y + oy, x + ox, y + oy),
    arc: (x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean) => ctx.arc(x + ox, y + oy, r, a0, a1, ccw),
  } as unknown as CanvasRenderingContext2D;
}

/**
 * A link-drawing closure for the chosen layout/curve. Radial layouts are origin-centred by
 * d3-shape's `pointRadial`/`linkRadial`; `center` ([ox, oy], the canvas centre) is baked into
 * the emitted coordinates so the radial tree is centred at the IDENTITY transform (no centring
 * `setTransform`, so the user's zoom survives layout/curve toggles).
 */
function makeLinkDraw(mode: LayoutMode, curve: CurveMode, center: [number, number]): (ctx: CanvasRenderingContext2D, l: PLink) => void {
  const [ox, oy] = center;
  if (mode === "rectangular") {
    const factory = curve === "linear" ? curveLinear : curve === "step" ? curveStepBefore : curveBumpX;
    const gen = d3link<PLink, PNode>(factory).x((d) => d.y).y((d) => d.x);
    return (ctx, l) => { gen.context(ctx); gen(l); };
  }
  if (curve === "bump") {
    // linkRadial emits curves around (0,0); wrap the context in an offsetting proxy so the
    // figure lands at the canvas centre (the d3gl path context has no translate()).
    const gen = linkRadial<PLink, PNode>().angle((d) => d.x).radius((d) => d.y);
    return (ctx, l) => { gen.context(offsetCtx(ctx, ox, oy)); gen(l); };
  }
  if (curve === "linear") {
    return (ctx, l) => {
      const [sx, sy] = pointRadial(l.source.x, l.source.y);
      const [tx, ty] = pointRadial(l.target.x, l.target.y);
      ctx.moveTo(sx + ox, sy + oy); ctx.lineTo(tx + ox, ty + oy);
    };
  }
  // radial "step": arc along the parent radius to the child angle, then a radial line out.
  return (ctx, l) => {
    const r0 = l.source.y;
    const sa = l.source.x - Math.PI / 2;
    const ta = l.target.x - Math.PI / 2;
    ctx.moveTo(r0 * Math.cos(sa) + ox, r0 * Math.sin(sa) + oy);
    ctx.arc(ox, oy, r0, sa, ta, ta < sa);
    const [tx, ty] = pointRadial(l.target.x, l.target.y);
    ctx.lineTo(tx + ox, ty + oy);
  };
}

/** The node's displayed distribution: the reconstructed range set (membership), each region
 *  sized by its aggregated occurrence count (sorted by count). Falls back to equal slices if
 *  every set region has zero count (a region reconstructed only from a sibling clade). */
function pieSlices(node: PNode): { clusterId: number; count: number; a0: number; a1: number }[] {
  const counts = new Map((node.data.clusters?.clusters ?? []).map((r) => [r.clusterId, r.count]));
  const regs = (node.data.ranges?.clusters ?? [])
    .map((r) => ({ clusterId: r.clusterId, count: counts.get(r.clusterId) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.clusterId - b.clusterId);
  if (regs.length === 0) return [];
  const tot = regs.reduce((s, r) => s + r.count, 0);
  let a = -Math.PI / 2;
  return regs.map((r) => {
    const frac = tot > 0 ? r.count / tot : 1 / regs.length;
    const a0 = a, a1 = a + frac * 2 * Math.PI;
    a = a1;
    return { clusterId: r.clusterId, count: r.count, a0, a1 };
  });
}

/** The dominant region of a node's DISPLAYED range — the highest-count slice within the
 *  reconstructed range (so the branch color matches the pie, never a region outside it). */
function topRegion(node: PNode): number | undefined {
  return pieSlices(node)[0]?.clusterId;
}

/** Hover-tooltip body: a small table of the node's reconstructed regions, each row sized
 *  exactly as its pie wedge (share = wedge angle / 2π) and labelled with its occurrence
 *  count. The header names a tip species or, for an internal node, its subtended clade
 *  size. Built with d3gl's `h` hyperscript so the engine's shared tooltip renders it. */
function rangeTable(node: PNode): HTMLElement | null {
  const slices = pieSlices(node);
  if (slices.length === 0) return null;
  const header = node.children ? `${node.data.speciesCount ?? 1} species` : node.data.name;
  return h("div", null, [
    h("div", { class: "mb-1 font-semibold" }, header),
    h("table", { class: "border-collapse" }, slices.map((s) => {
      const share = Math.round(((s.a1 - s.a0) / (2 * Math.PI)) * 100);
      return h("tr", null, [
        h("td", { class: "pr-1.5" },
          h("span", {
            class: "inline-block h-2.5 w-2.5 rounded-sm align-middle",
            style: `background:${regionColor(s.clusterId)}`,
          })),
        h("td", { class: "pr-2.5" }, REGION_NAMES[s.clusterId] ?? `#${s.clusterId}`),
        h("td", { class: "pr-1.5 text-right tabular-nums" }, s.count),
        h("td", { class: "text-right tabular-nums opacity-60" }, `${share}%`),
      ]);
    })),
  ]);
}

/** Constant screen-px offset from the node: rightward (rectangular) or outward along the
 *  radius (radial). Vertical centering for rectangular is folded in as -height/2. */
function labelOffset(mode: LayoutMode, angle: number, gap: number, height: number): [number, number] {
  if (mode !== "radial") return [gap, -height / 2];
  const a = angle - Math.PI / 2; // pointRadial's outward direction
  return [Math.cos(a) * gap, Math.sin(a) * gap];
}

/**
 * A mammal phylogeny with ancestral ranges reconstructed by Fitch maximum
 * parsimony: branch width encodes subtended terminals, node pies show the
 * count-weighted range distribution (always on). Reads `layout`
 * (rectangular | radial), `curve` (linear | step | bump), and `coords`
 * (screen | world) from the harness options. Pure d3gl; the harness owns the
 * controls, backend, export, and zoom.
 *
 * Hovering a node pie or a branch shows a region tooltip (`rangeTable`) and a
 * highlight, driven by the engine's pick path (a per-layer hit index + a
 * `pick()` on each pointermove).
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const W = width, H = height;

  // HTML label overlay over the canvas (host is positioned `relative` by the harness).
  const labelEl = document.createElement("div");
  labelEl.className = "absolute inset-0 pointer-events-none overflow-hidden text-[11px] leading-[14px] text-[#333]";

  const chart = plot(host, { width: W, height: H, backend });
  host.appendChild(labelEl);
  const labels = new LabelLayer(labelEl, (a) => a.text);

  // Label anchors are rebuilt by `render`; the zoom handler keeps them aligned with the GPU
  // geometry. The transform stays at identity in both layouts (radial centering is baked into
  // the world coordinates below), so the user's zoom/pan is never reset by an option change.
  let anchors: LabelAnchor[] = [];
  let view: { k: number; x: number; y: number } = { k: 1, x: 0, y: 0 };
  const updateLabels = (t = view): void => {
    view = t;
    labels.update(anchors, t, { width: W, height: H });
  };
  // Scroll to zoom, drag to pan; keep the HTML tip labels aligned with the GPU geometry.
  chart.enableZoom([0.5, 40], (t) => updateLabels(t));

  return {
    engine: chart,
    // (Re)build all option-dependent layers on the existing chart. Never touches the transform,
    // so toggling layout/curve/coords or growing the tree preserves the current zoom/pan.
    render: (options) => {
      const tips = 2 ** ((options.tips as number) ?? 6); // 2^exp tips (exp 5..9 → 32..512)
      const layoutMode = (options.layout as LayoutMode) ?? "rectangular";
      const curve = (options.curve as CurveMode) ?? "step";
      const sizeMode = (options.coords as SizeMode) ?? "screen";

      // Build the tree, occurrence-count distribution, and the final Fitch phase (unconditional).
      const tree = makeMammalTree(tips, 1);
      const cps = assignBioregions(tree, REGION_NAMES.length, 1);
      aggregateClusters(tree, cps);
      calcMaximumParsimony(tree, cps);
      aggregateSpeciesCount(tree);

      const root = layoutMode === "rectangular"
        ? layoutRectangular(tree, W, H, "linear")
        // Radial is a half-circle "sunset" fan (Fig. 3a): leaves span π, centred on north.
        : layoutRadial(tree, W, H, "linear", 50, Math.PI, -Math.PI / 2);
      const links = root.links();
      const tipNodes = root.leaves();
      const totalSpecies = root.data.speciesCount ?? 1;

      // Bake the radial centering into WORLD coordinates so the fan is centred at the IDENTITY
      // transform (no centring setTransform → zoom survives a layout toggle). Rectangular keeps
      // d3's origin (offset [0,0]). The half-circle fan's vertical centre is (H + R) / 2.
      const R = layoutMode === "radial" ? Math.max(...tipNodes.map((n) => n.y)) : 0;
      const center: [number, number] = layoutMode === "radial" ? [W / 2, (H + R) / 2] : [0, 0];
      const [ox, oy] = center;
      const xy = (n: PNode): [number, number] => {
        const [x, y] = nodeXY(n, layoutMode);
        return [x + ox, y + oy];
      };

      const widthScale = scaleSqrt().domain([1, totalSpecies]).range([LINE_MIN, LINE_MAX]);
      const widthBase = (n: PNode): number => widthScale(n.data.speciesCount ?? 1);
      // World mode: pie diameter = the incoming branch width (scales with zoom). Screen mode:
      // a fixed pixel size so even small-clade nodes stay visible when zoomed in.
      const SCREEN_PIE_R = 8;
      const pieR = (n: PNode): number => (sizeMode === "screen" ? SCREEN_PIE_R : widthBase(n) / 2);

      const pieSpecs: PieSpec[] = root.descendants().map((n) => {
        const [cx, cy] = xy(n);
        return { cx, cy, rBase: pieR(n), node: n, slices: pieSlices(n) };
      }).filter((p) => p.slices.length > 0);

      const GAP = 8;
      const radial = layoutMode === "radial";
      anchors = tipNodes.map((n, i) => {
        const [px, py] = xy(n);
        const h = 14;
        return {
          id: `t${i}`, refX: px, refY: py, text: n.data.name,
          width: n.data.name.length * 6.2 + 6, height: h,
          priority: n.data.speciesCount ?? 1,
          offset: labelOffset(layoutMode, n.x, GAP, h),
          // Radial: declare the reading angle; d3gl derives the CSS transform AND the oriented
          // collision box from it, so rotated tip labels pack by their true on-screen footprint.
          ...(radial ? { rotation: n.x - Math.PI / 2, textAnchor: "start" as const, keepUpright: true } : {}),
        };
      });

      const drawLink = makeLinkDraw(layoutMode, curve, center);

      chart.layer("links", links, {
        draw: (ctx, l) => drawLink(ctx, l),
        // Color each branch by the child clade's most-occurring bioregion.
        stroke: (l: PLink) => { const t = topRegion(l.target); return t == null ? "#777" : regionColor(t); },
        lineWidth: (l: PLink) => widthBase(l.target),
        sizeMode,
        id: (_l, i) => i,
        // Hovering a branch darkens it and reads out its child clade's range distribution.
        hover: { stroke: "#111" },
        tooltip: (l: PLink) => rangeTable(l.target),
      });

      const wedges: Wedge[] = [];
      for (const p of pieSpecs) {
        const single = p.slices.length === 1;
        for (const s of p.slices) wedges.push({ cx: p.cx, cy: p.cy, r: p.rBase, a0: s.a0, a1: s.a1, clusterId: s.clusterId, count: s.count, single, node: p.node });
      }
      chart.layer("pies", wedges, {
        draw: (ctx, w) => {
          // Single-region node: a full circle. closePath() so the subpath is closed and the
          // WebGL fill tessellator (which fills only closed subpaths) renders it like Canvas/SVG.
          if (w.single) { ctx.moveTo(w.cx + w.r, w.cy); ctx.arc(w.cx, w.cy, w.r, 0, 2 * Math.PI); ctx.closePath(); }
          else { ctx.moveTo(w.cx, w.cy); ctx.arc(w.cx, w.cy, w.r, w.a0, w.a1); ctx.closePath(); }
        },
        fill: (w: Wedge) => regionColor(w.clusterId),
        stroke: "#ffffff",
        lineWidth: (w: Wedge) => (w.single ? 0 : Math.min(0.5, w.r * 0.16)),
        anchor: (w: Wedge) => [w.cx, w.cy], // pin the pie; screen mode keeps it constant-size
        sizeMode,
        // Screen mode: declutter overlapping fixed-size pies on zoom (bigger clades win).
        declutter: sizeMode === "screen" ? SCREEN_PIE_R * 2 + 2 : undefined,
        id: (_w, i) => i,
        // Hovering a pie outlines the wedge and reads out the whole node's range distribution.
        hover: { stroke: "#222", lineWidth: 1 },
        tooltip: (w: Wedge) => rangeTable(w.node),
      });

      chart.render();
      updateLabels(); // re-place labels at the CURRENT transform (preserved across option changes)
    },
    dispose: () => labels.destroy(),
  };
};
