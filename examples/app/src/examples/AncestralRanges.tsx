import React, { useEffect, useRef, useState } from "react";
import { schemeCategory10 } from "d3-scale-chromatic";
import { scaleOrdinal, scaleSqrt } from "d3-scale";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent, zoomIdentity } from "d3-zoom";
import { link as d3link, linkRadial, curveLinear, curveStepBefore, curveBumpX, pointRadial } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot, type Plot, type HoverHit } from "@d3gl/map";
import { LabelLayer, type LabelAnchor } from "@d3gl/labels";
import type { ViewTransform } from "@d3gl/core";
import type { TreeNode } from "./tree.js";
import { layoutRectangular, layoutRadial, nodeXY, type LayoutMode } from "./layout.js";
import { makeMammalTree, assignBioregions, REGION_NAMES } from "./mammals-data.js";
import { calcMaximumParsimony, calcMaximumParsimonyPreliminaryPhase, aggregateClusters, aggregateSpeciesCount } from "./parsimony.js";

const W = 900;
const H = 600;
const CX = W / 2;
const LINE_BASE = 1.6; // branch width when thickness scaling is off
const LINE_MIN = 1, LINE_MAX = 22; // branch-width range when scaling by subtended terminals

type BackendType = "webgl" | "canvas" | "svg";
type SizeMode = "world" | "screen";
type CurveMode = "linear" | "step" | "bump";
type Phase = "final" | "preliminary";
type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

const regionColor = scaleOrdinal<number, string>()
  .domain(REGION_NAMES.map((_, i) => i))
  .range(schemeCategory10 as string[]);

/** One pie slice: a bioregion + its share, as start/end angles, at a node center. */
interface Wedge { cx: number; cy: number; r: number; a0: number; a1: number; clusterId: number; count: number; single: boolean; node: PNode; }
/** Per-node pie before sizing: center, base radius, and angular slices (size-independent). */
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

// Rotation/centering only — the constant-px gap from the node is the LabelAnchor `offset`
// (which the LabelLayer also uses for collision, so labels keep their distance and don't
// overlap as you zoom).
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

interface Tip { left: number; top: number; name: string; kind: string; rows: { name: string; color: string; count: number }[]; }

export function AncestralRanges(): React.ReactElement {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("radial");
  const [backend, setBackend] = useState<BackendType>("webgl");
  const [tips, setTips] = useState(64);
  const [thickness, setThickness] = useState(true);
  const [pies, setPies] = useState(true);
  const [sizeMode, setSizeMode] = useState<SizeMode>("world");
  const [curve, setCurve] = useState<CurveMode>("step");
  const [phase, setPhase] = useState<Phase>("final");
  const [tooltip, setTooltip] = useState<Tip | null>(null);

  const chartRef = useRef<Plot | null>(null);
  const labelLayerRef = useRef<LabelLayer | null>(null);
  const transformRef = useRef<ViewTransform>({ k: 1, x: 0, y: 0 });
  const hostRef = useRef<HTMLDivElement>(null);
  const labelContainerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef<LabelAnchor[]>([]);
  const zoomBehaviorRef = useRef<ReturnType<typeof d3zoom<HTMLDivElement, unknown>> | null>(null);
  // Identifies the current geometry (layout + tip count). The view is reset to base only when
  // this changes — toggles like phase/thickness/pies keep the user's current pan/zoom.
  const viewKeyRef = useRef("");

  useEffect(() => {
    const host = hostRef.current;
    const labelContainer = labelContainerRef.current;
    const wrapper = wrapRef.current;
    if (!host || !labelContainer || !wrapper) return;

    const chart = plot(host, { width: W, height: H, backend });
    chartRef.current = chart;
    const labelLayer = new LabelLayer(labelContainer, (a) => a.text);
    labelLayerRef.current = labelLayer;

    chart.on("hover", (hit: HoverHit | null, ev: PointerEvent) => {
      const el = wrapRef.current;
      if (!hit || hit.layer !== "pies" || !el) { setTooltip(null); return; }
      const w = hit.datum as Wedge | null;
      if (!w) { setTooltip(null); return; }
      const r = el.getBoundingClientRect();
      const rows = pieSlices(w.node).map((s) => ({ name: REGION_NAMES[s.clusterId] ?? `#${s.clusterId}`, color: regionColor(s.clusterId), count: s.count }));
      setTooltip({
        left: ev.clientX - r.left + 12, top: ev.clientY - r.top + 12,
        name: w.node.data.name, kind: w.node.children ? "ancestral range" : "current distribution", rows,
      });
    });

    const zoomBehavior = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.4, 200])
      .on("zoom", (e: D3ZoomEvent<HTMLDivElement, unknown>) => {
        const t = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        transformRef.current = t;
        chart.setTransform(t); // sizeMode is baked into the layers; the backend keeps screen sizes constant
        labelLayer.update(anchorsRef.current, t, { width: W, height: H });
      });
    zoomBehaviorRef.current = zoomBehavior;
    select(wrapper).call(zoomBehavior);

    return () => {
      chart.destroy();
      labelLayer.destroy();
      select(wrapper).on(".zoom", null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { chartRef.current?.setBackend(backend); }, [backend]);

  useEffect(() => {
    const chart = chartRef.current;
    const labelLayer = labelLayerRef.current;
    const wrapper = wrapRef.current;
    const zoomBehavior = zoomBehaviorRef.current;
    if (!chart || !labelLayer || !wrapper || !zoomBehavior) return;

    // Build the tree, occurrence-count distribution, and the chosen Fitch phase.
    const tree = makeMammalTree(tips, 1);
    const cps = assignBioregions(tree, REGION_NAMES.length, 1);
    aggregateClusters(tree, cps);
    if (phase === "final") calcMaximumParsimony(tree, cps);
    else calcMaximumParsimonyPreliminaryPhase(tree, cps);
    aggregateSpeciesCount(tree);

    const root = layoutMode === "rectangular"
      ? layoutRectangular(tree, W, H, "linear")
      // Radial is a half-circle "sunset" fan (Fig. 3a): leaves span π, centred on north.
      : layoutRadial(tree, W, H, "linear", 50, Math.PI, -Math.PI / 2);
    const links = root.links();
    const tipNodes = root.leaves();
    const totalSpecies = root.data.speciesCount ?? 1;

    const widthScale = scaleSqrt().domain([1, totalSpecies]).range([LINE_MIN, LINE_MAX]);
    const widthBase = (n: PNode): number => (thickness ? widthScale(n.data.speciesCount ?? 1) : LINE_BASE);
    // World mode: pie diameter = the incoming branch width (scales with zoom). Screen mode:
    // a fixed pixel size so even small-clade nodes stay visible when zoomed in.
    const SCREEN_PIE_R = 8;
    const pieR = (n: PNode): number => (sizeMode === "screen" ? SCREEN_PIE_R : widthBase(n) / 2);

    const pieSpecs: PieSpec[] = pies
      ? root.descendants().map((n) => {
          const [cx, cy] = nodeXY(n, layoutMode);
          return { cx, cy, rBase: pieR(n), node: n, slices: pieSlices(n) };
        }).filter((p) => p.slices.length > 0)
      : [];

    // Centre a half-circle fan vertically; full radial / rectangular keep their origins.
    const R = layoutMode === "radial" ? Math.max(...tipNodes.map((n) => n.y)) : 0;
    const base = layoutMode === "radial" ? zoomIdentity.translate(CX, (H + R) / 2) : zoomIdentity;
    // Reset the view to base only when the geometry changes (layout / tip count); otherwise
    // keep the user's current pan/zoom across style toggles.
    const viewKey = `${layoutMode}:${tips}`;
    const reset = viewKeyRef.current !== viewKey;
    viewKeyRef.current = viewKey;
    const view: ViewTransform = reset ? { k: base.k, x: base.x, y: base.y } : transformRef.current;
    if (reset) select(wrapper).call(zoomBehavior.transform, base);
    transformRef.current = view;

    const GAP = 8;
    anchorsRef.current = tipNodes.map((n, i) => {
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

    // Build the layers once with the chosen sizeMode. In "screen" mode the backend keeps
    // branch widths and pie diameters at a constant pixel size around their world anchors as
    // you zoom — no per-zoom rebuild needed (the core sizeMode handles it).
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
    labelLayer.update(anchorsRef.current, view, { width: W, height: H });
  }, [layoutMode, tips, thickness, pies, sizeMode, curve, phase]);

  const exportPNG = (): void => {
    try { download(chartRef.current!.toPNG(), "ancestral-ranges.png"); }
    catch { alert("PNG export needs the WebGL or Canvas backend."); }
  };
  const exportSVG = (): void => {
    download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(chartRef.current?.toSVG() ?? "")}`, "ancestral-ranges.svg");
  };

  const btn = (active: boolean) => ({
    padding: "3px 9px", fontSize: 13, borderRadius: 5, cursor: active ? "default" : "pointer",
    border: "1px solid #ccc", background: active ? "#1a73e8" : "#fff", color: active ? "#fff" : "#222",
  });

  return (
    <div style={{ padding: 16, color: "#222" }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 4px" }}>
        Ancestral ranges — mammal tree with Fitch reconstruction ({layoutMode}, {tips} species, {phase})
      </h1>
      <p style={{ margin: "0 0 12px", fontSize: 12, opacity: 0.7 }}>
        Pies show the bioregion distribution (current at tips, most-parsimonious ancestral range at internal nodes), sized by
        occurrence count; branches are colored by the descendant clade's dominant bioregion and scaled to subtended species. A standalone Fig. 3a test.
      </p>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {(["webgl", "canvas", "svg"] as const).map((b) => (
          <button key={b} style={btn(backend === b)} onClick={() => setBackend(b)} disabled={backend === b}>{b}</button>
        ))}
        <Sep />
        {(["rectangular", "radial"] as const).map((m) => (
          <button key={m} style={btn(layoutMode === m)} onClick={() => setLayoutMode(m)}>{m}</button>
        ))}
        <Sep />
        {(["linear", "step", "bump"] as const).map((c) => (
          <button key={c} style={btn(curve === c)} onClick={() => setCurve(c)}>{c}</button>
        ))}
        <Sep />
        {(["preliminary", "final"] as const).map((p) => (
          <button key={p} style={btn(phase === p)} onClick={() => setPhase(p)}>{p}</button>
        ))}
        <Sep />
        <button style={btn(thickness)} onClick={() => setThickness((v) => !v)}>thickness</button>
        <button style={btn(pies)} onClick={() => setPies((v) => !v)}>pies</button>
        <button style={btn(false)} onClick={() => setSizeMode((m) => (m === "world" ? "screen" : "world"))}>size: {sizeMode}</button>
        <Sep />
        <label style={{ fontSize: 13 }}>
          species {tips}
          <input type="range" min={64} max={2048} step={64} value={tips}
            onChange={(e) => setTips(Number(e.target.value))} style={{ marginLeft: 6, verticalAlign: "middle" }} />
        </label>
        <Sep />
        <button style={btn(false)} onClick={exportPNG}>PNG</button>
        <button style={btn(false)} onClick={exportSVG}>SVG</button>
      </div>

      <div ref={wrapRef} style={{ position: "relative", width: W, height: H, background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, cursor: "crosshair", overflow: "hidden" }}>
        <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
        <div ref={labelContainerRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", fontSize: 11, lineHeight: "14px", color: "#333" }} />
        {tooltip && (
          <div style={{
            position: "absolute", left: tooltip.left, top: tooltip.top, pointerEvents: "none",
            background: "rgba(255,255,255,0.97)", border: "1px solid #ccc", borderRadius: 4,
            padding: "5px 8px", fontSize: 12, whiteSpace: "nowrap", color: "#222", boxShadow: "0 1px 4px rgba(0,0,0,0.15)", zIndex: 10,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>{tooltip.name}</div>
            <div style={{ opacity: 0.6, marginBottom: 4 }}>{tooltip.kind}</div>
            <table style={{ borderCollapse: "collapse" }}>
              <tbody>
                {tooltip.rows.map((r) => (
                  <tr key={r.name}>
                    <td style={{ paddingRight: 6 }}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: r.color }} /></td>
                    <td style={{ paddingRight: 10 }}>{r.name}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, fontSize: 12 }}>
        {REGION_NAMES.map((name, i) => (
          <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 11, height: 11, borderRadius: 2, background: regionColor(i), display: "inline-block" }} />
            {name}
          </span>
        ))}
      </div>
      <p style={{ opacity: 0.6, fontSize: 12 }}>scroll to zoom · drag to pan · hover a node for its range table · toggle size: world/screen · preliminary/final = Fitch phase</p>
    </div>
  );
}

function Sep(): React.ReactElement {
  return <span style={{ width: 1, alignSelf: "stretch", background: "#ddd", margin: "0 4px" }} />;
}

function download(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href; a.download = filename; a.click();
}
