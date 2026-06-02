import React, { useEffect, useRef, useState } from "react";
import { schemeCategory10 } from "d3-scale-chromatic";
import { scaleOrdinal, scaleSqrt } from "d3-scale";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent, zoomIdentity } from "d3-zoom";
import { link as d3link, linkRadial, curveStepBefore } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot, type Plot, type HoverHit } from "@d3gl/map";
import { LabelLayer, type LabelAnchor } from "@d3gl/labels";
import type { ViewTransform } from "@d3gl/core";
import type { TreeNode } from "./tree.js";
import { layoutRectangular, layoutRadial, nodeXY, type LayoutMode } from "./layout.js";
import { makeMammalTree, assignBioregions, REGION_NAMES } from "./mammals-data.js";
import { calcMaximumParsimony, aggregateClusters, aggregateSpeciesCount } from "./parsimony.js";

const W = 900;
const H = 600;
const CX = W / 2;
const CY = H / 2;
const LINE_BASE = 1.6; // branch width when thickness scaling is off
const LINE_MIN = 1.6, LINE_MAX = 22; // branch-width range when scaling by subtended terminals

type BackendType = "webgl" | "canvas" | "svg";
type SizeMode = "world" | "screen";
type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

const regionColor = scaleOrdinal<number, string>()
  .domain(REGION_NAMES.map((_, i) => i))
  .range(schemeCategory10 as string[]);

/** One pie slice: a bioregion + its share, as start/end angles, at a node center. */
interface Wedge { cx: number; cy: number; r: number; a0: number; a1: number; clusterId: number; count: number; single: boolean; node: PNode; }
/** Per-node pie before sizing: center, base radius, and angular slices (size-independent). */
interface PieSpec { cx: number; cy: number; rBase: number; node: PNode; slices: { clusterId: number; count: number; a0: number; a1: number }[]; }

function makeLinkDraw(mode: LayoutMode): (ctx: CanvasRenderingContext2D, l: PLink) => void {
  if (mode === "rectangular") {
    const gen = d3link<PLink, PNode>(curveStepBefore).x((d) => d.y).y((d) => d.x);
    return (ctx, l) => { gen.context(ctx); gen(l); };
  }
  const gen = linkRadial<PLink, PNode>().angle((d) => d.x).radius((d) => d.y);
  return (ctx, l) => { gen.context(ctx); gen(l); };
}

/** The node's displayed distribution: the parsimony ancestral range set (membership),
 *  each region sized by its aggregated occurrence count (sorted by count). If every set
 *  region has zero count (rare — a region reconstructed only from a sibling clade), fall
 *  back to equal slices so the range is still visible. */
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

function labelTransform(mode: LayoutMode, angle: number, gap: number): string {
  if (mode !== "radial") return `translate(${gap}px, -50%)`;
  const deg = (angle * 180) / Math.PI - 90;
  return Math.sin(angle) < 0
    ? `rotate(${deg + 180}deg) translate(${-gap}px, -50%) translate(-100%, 0)`
    : `rotate(${deg}deg) translate(${gap}px, -50%)`;
}

export function AncestralRanges(): React.ReactElement {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("radial");
  const [backend, setBackend] = useState<BackendType>("webgl");
  const [tips, setTips] = useState(256);
  const [thickness, setThickness] = useState(true);
  const [pies, setPies] = useState(true);
  const [sizeMode, setSizeMode] = useState<SizeMode>("world");
  const [tooltip, setTooltip] = useState<{ left: number; top: number; text: string } | null>(null);

  const chartRef = useRef<Plot | null>(null);
  const labelLayerRef = useRef<LabelLayer | null>(null);
  const transformRef = useRef<ViewTransform>({ k: 1, x: 0, y: 0 });
  const hostRef = useRef<HTMLDivElement>(null);
  const labelContainerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef<LabelAnchor[]>([]);
  const zoomBehaviorRef = useRef<ReturnType<typeof d3zoom<HTMLDivElement, unknown>> | null>(null);
  // The latest layer-rebuild closure (built by the data effect; called on zoom in screen mode).
  const rebuildRef = useRef<((k: number) => void) | null>(null);
  const sizeModeRef = useRef<SizeMode>(sizeMode); sizeModeRef.current = sizeMode;
  const pendingKRef = useRef(1);
  const rafRef = useRef(0);

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
      const dist = pieSlices(w.node).map((s) => `${REGION_NAMES[s.clusterId] ?? `#${s.clusterId}`} ${s.count}`).join(", ");
      const kind = w.node.children ? "ancestral range" : "distribution";
      setTooltip({ left: ev.clientX - r.left + 12, top: ev.clientY - r.top + 12, text: `${w.node.data.name} · ${kind}: ${dist}` });
    });

    const scheduleRebuild = (): void => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; rebuildRef.current?.(pendingKRef.current); });
    };
    const zoomBehavior = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.4, 200])
      .on("zoom", (e: D3ZoomEvent<HTMLDivElement, unknown>) => {
        const t = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        transformRef.current = t;
        pendingKRef.current = t.k;
        chart.setTransform(t);
        labelLayer.update(anchorsRef.current, t, { width: W, height: H });
        if (sizeModeRef.current === "screen") scheduleRebuild(); // keep pies/branches constant px
      });
    zoomBehaviorRef.current = zoomBehavior;
    select(wrapper).call(zoomBehavior);

    return () => {
      chart.destroy();
      labelLayer.destroy();
      select(wrapper).on(".zoom", null);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
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

    // Build the tree, occurrence-count distribution, ancestral ranges (Fitch) and counts.
    const tree = makeMammalTree(tips, 1);
    const cps = assignBioregions(tree, REGION_NAMES.length, 1);
    aggregateClusters(tree, cps);
    calcMaximumParsimony(tree, cps);
    aggregateSpeciesCount(tree);

    const root = layoutMode === "rectangular"
      ? layoutRectangular(tree, W, H, "linear")
      : layoutRadial(tree, W, H, "linear");
    const links = root.links();
    const tipNodes = root.leaves();
    const totalSpecies = root.data.speciesCount ?? 1;

    // Branch width ∝ subtended terminals; pie diameter = the node's incoming branch width.
    const widthScale = scaleSqrt().domain([1, totalSpecies]).range([LINE_MIN, LINE_MAX]);
    const widthBase = (n: PNode): number => (thickness ? widthScale(n.data.speciesCount ?? 1) : LINE_BASE);

    const pieSpecs: PieSpec[] = pies
      ? root.descendants().map((n) => {
          const [cx, cy] = nodeXY(n, layoutMode);
          return { cx, cy, rBase: widthBase(n) / 2, node: n, slices: pieSlices(n) };
        }).filter((p) => p.slices.length > 0)
      : [];

    const base = layoutMode === "radial" ? zoomIdentity.translate(CX, CY) : zoomIdentity;
    const baseT: ViewTransform = { k: base.k, x: base.x, y: base.y };
    select(wrapper).call(zoomBehavior.transform, base);
    transformRef.current = baseT;
    pendingKRef.current = baseT.k;

    const GAP = 8;
    anchorsRef.current = tipNodes.map((n, i) => {
      const [px, py] = nodeXY(n, layoutMode);
      return {
        id: `t${i}`, refX: px, refY: py, text: n.data.name,
        width: n.data.name.length * 6.2 + 6, height: 14,
        priority: n.data.speciesCount ?? 1,
        transformOrigin: "0 0", transform: labelTransform(layoutMode, n.x, GAP),
      };
    });

    const drawLink = makeLinkDraw(layoutMode);

    // Rebuild the branch + pie layers at a given zoom k. In "screen" mode sizes are divided
    // by k so they render at a constant pixel size (the backend re-multiplies by k); in
    // "world" mode they scale with zoom. Pie angles are precomputed; only radius changes.
    const rebuild = (k: number): void => {
      const scale = sizeModeRef.current === "screen" ? 1 / k : 1;
      chart.layer("links", links, {
        draw: (ctx, l) => drawLink(ctx, l),
        stroke: "#777",
        lineWidth: (l: PLink) => widthBase(l.target) * scale,
      });
      const wedges: Wedge[] = [];
      for (const p of pieSpecs) {
        const single = p.slices.length === 1;
        for (const s of p.slices) wedges.push({ cx: p.cx, cy: p.cy, r: p.rBase * scale, a0: s.a0, a1: s.a1, clusterId: s.clusterId, count: s.count, single, node: p.node });
      }
      chart.layer("pies", wedges, {
        draw: (ctx, w) => {
          if (w.single) { ctx.moveTo(w.cx + w.r, w.cy); ctx.arc(w.cx, w.cy, w.r, 0, 2 * Math.PI); } // full circle, no center seam
          else { ctx.moveTo(w.cx, w.cy); ctx.arc(w.cx, w.cy, w.r, w.a0, w.a1); ctx.closePath(); }
        },
        fill: (w: Wedge) => regionColor(w.clusterId),
        stroke: "#ffffff",
        lineWidth: (w: Wedge) => (w.single ? 0 : Math.min(0.5, w.r * 0.16)), // thin separators, none on circles
        id: (_w, i) => i,
      });
    };
    rebuildRef.current = rebuild;
    rebuild(baseT.k);

    chart.setTransform(baseT);
    labelLayer.update(anchorsRef.current, baseT, { width: W, height: H });
  }, [layoutMode, tips, thickness, pies, sizeMode]);

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
        Ancestral ranges — mammal tree with Fitch reconstruction ({layoutMode}, {tips} species)
      </h1>
      <p style={{ margin: "0 0 12px", fontSize: 12, opacity: 0.7 }}>
        Pies show the bioregion distribution (current at tips, most-parsimonious ancestral range at internal nodes), sized by
        occurrence count; branch thickness and pie diameter scale with the number of subtended species. A standalone Fig. 3a test.
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
            background: "rgba(255,255,255,0.96)", border: "1px solid #ccc", borderRadius: 4,
            padding: "4px 8px", fontSize: 12, whiteSpace: "nowrap", color: "#222", boxShadow: "0 1px 4px rgba(0,0,0,0.15)", zIndex: 10,
          }}>{tooltip.text}</div>
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
      <p style={{ opacity: 0.6, fontSize: 12 }}>scroll to zoom · drag to pan · hover a pie for the species and its ranges · toggle size: world/screen</p>
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
