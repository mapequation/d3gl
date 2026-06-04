import { schemeCategory10 } from "d3-scale-chromatic";
import { scaleOrdinal, scaleSqrt } from "d3-scale";
import { zoomIdentity } from "d3-zoom";
import { link as d3link, linkRadial, curveLinear, curveStepBefore, curveBumpX, pointRadial } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot } from "@mapequation/d3gl/map";
import { LabelLayer, type LabelAnchor } from "@mapequation/d3gl/labels";
import type { ImperativeSetup } from "../types.js";
import type { TreeNode } from "../shared/tree.js";
import { layoutRectangular, layoutRadial, nodeXY, type LayoutMode } from "../shared/layout.js";
import { makeMammalTree, assignBioregions, REGION_NAMES } from "../shared/mammals-data.js";
import { calcMaximumParsimony, aggregateClusters, aggregateSpeciesCount } from "../shared/parsimony.js";

const LINE_MIN = 1, LINE_MAX = 22; // branch-width range when scaling by subtended terminals
const TIPS = 64; // fixed mammal-tree size (the source's initial tips value)

type SizeMode = "world" | "screen";
type CurveMode = "linear" | "step" | "bump";
type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

const regionColor = scaleOrdinal<number, string>()
  .domain(REGION_NAMES.map((_, i) => i))
  .range(schemeCategory10 as string[]);

interface Wedge { cx: number; cy: number; r: number; a0: number; a1: number; clusterId: number; count: number; single: boolean; node: PNode; }
interface PieSpec { cx: number; cy: number; rBase: number; node: PNode; slices: { clusterId: number; count: number; a0: number; a1: number }[]; }

function makeLinkDraw(mode: LayoutMode, curve: CurveMode): (ctx: CanvasRenderingContext2D, l: PLink) => void {
  if (mode === "rectangular") {
    const factory = curve === "linear" ? curveLinear : curve === "step" ? curveStepBefore : curveBumpX;
    const gen = d3link<PLink, PNode>(factory).x((d) => d.y).y((d) => d.x);
    return (ctx, l) => { gen.context(ctx); gen(l); };
  }
  if (curve === "bump") {
    const gen = linkRadial<PLink, PNode>().angle((d) => d.x).radius((d) => d.y);
    return (ctx, l) => { gen.context(ctx); gen(l); };
  }
  if (curve === "linear") {
    return (ctx, l) => {
      const [sx, sy] = pointRadial(l.source.x, l.source.y);
      const [tx, ty] = pointRadial(l.target.x, l.target.y);
      ctx.moveTo(sx, sy); ctx.lineTo(tx, ty);
    };
  }
  // radial "step": arc along the parent radius to the child angle, then a radial line out.
  return (ctx, l) => {
    const r0 = l.source.y;
    const sa = l.source.x - Math.PI / 2;
    const ta = l.target.x - Math.PI / 2;
    ctx.moveTo(r0 * Math.cos(sa), r0 * Math.sin(sa));
    ctx.arc(0, 0, r0, sa, ta, ta < sa);
    const [tx, ty] = pointRadial(l.target.x, l.target.y);
    ctx.lineTo(tx, ty);
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

// Rotation/centering only — the constant-px gap from the node is the LabelAnchor `offset`.
function labelTransform(mode: LayoutMode, angle: number): string {
  if (mode !== "radial") return "";
  const deg = (angle * 180) / Math.PI - 90;
  return Math.sin(angle) < 0
    ? `rotate(${deg + 180}deg) translate(-100%, -50%)`
    : `rotate(${deg}deg) translate(0, -50%)`;
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
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const W = width, H = height;
  const CX = W / 2;
  const layoutMode = (options.layout as LayoutMode) ?? "rectangular";
  const curve = (options.curve as CurveMode) ?? "step";
  const sizeMode = (options.coords as SizeMode) ?? "screen";

  // HTML label overlay over the canvas (host is positioned `relative` by the harness).
  const labelEl = document.createElement("div");
  labelEl.className = "absolute inset-0 pointer-events-none overflow-hidden text-[11px] leading-[14px] text-[#333]";

  const chart = plot(host, { width: W, height: H, backend });

  // Build the tree, occurrence-count distribution, and the final Fitch phase (unconditional).
  const tree = makeMammalTree(TIPS, 1);
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

  const widthScale = scaleSqrt().domain([1, totalSpecies]).range([LINE_MIN, LINE_MAX]);
  const widthBase = (n: PNode): number => widthScale(n.data.speciesCount ?? 1);
  // World mode: pie diameter = the incoming branch width (scales with zoom). Screen mode:
  // a fixed pixel size so even small-clade nodes stay visible when zoomed in.
  const SCREEN_PIE_R = 8;
  const pieR = (n: PNode): number => (sizeMode === "screen" ? SCREEN_PIE_R : widthBase(n) / 2);

  const pieSpecs: PieSpec[] = root.descendants().map((n) => {
    const [cx, cy] = nodeXY(n, layoutMode);
    return { cx, cy, rBase: pieR(n), node: n, slices: pieSlices(n) };
  }).filter((p) => p.slices.length > 0);

  // Centre a half-circle fan vertically; full radial / rectangular keep their origins.
  const R = layoutMode === "radial" ? Math.max(...tipNodes.map((n) => n.y)) : 0;
  const base = layoutMode === "radial" ? zoomIdentity.translate(CX, (H + R) / 2) : zoomIdentity;
  const view = { k: base.k, x: base.x, y: base.y };

  const GAP = 8;
  const anchors: LabelAnchor[] = tipNodes.map((n, i) => {
    const [px, py] = nodeXY(n, layoutMode);
    const h = 14;
    return {
      id: `t${i}`, refX: px, refY: py, text: n.data.name,
      width: n.data.name.length * 6.2 + 6, height: h,
      priority: n.data.speciesCount ?? 1,
      transformOrigin: "0 0",
      offset: labelOffset(layoutMode, n.x, GAP, h),
      transform: labelTransform(layoutMode, n.x),
    };
  });

  const drawLink = makeLinkDraw(layoutMode, curve);

  chart.layer("links", links, {
    draw: (ctx, l) => drawLink(ctx, l),
    // Color each branch by the child clade's most-occurring bioregion.
    stroke: (l: PLink) => { const t = topRegion(l.target); return t == null ? "#777" : regionColor(t); },
    lineWidth: (l: PLink) => widthBase(l.target),
    sizeMode,
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
  });

  chart.setTransform(view);
  chart.render();

  host.appendChild(labelEl);
  const labels = new LabelLayer(labelEl, (a) => a.text);
  const updateLabels = (t = view) => labels.update(anchors, t, { width: W, height: H });
  updateLabels();

  // Scroll to zoom, drag to pan; keep the HTML tip labels aligned with the GPU geometry.
  // `enableZoom` seeds d3-zoom from the chart's current transform (`view`, set above), so the
  // first gesture is seamless — radial layouts centre the half-circle fan via `base`,
  // rectangular `base` is identity.
  chart.enableZoom([0.5, 40], (t) => updateLabels(t));

  return { engine: chart, dispose: () => labels.destroy() };
};
