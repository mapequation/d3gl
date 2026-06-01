import React, { useEffect, useRef, useState } from "react";
import { schemeCategory10 } from "d3-scale-chromatic";
import { scaleOrdinal, scaleSqrt } from "d3-scale";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent, zoomIdentity } from "d3-zoom";
import { link as d3link, linkRadial, curveStepBefore, pointRadial } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot, type Plot, type HoverHit } from "@d3gl/map";
import { LabelLayer, type LabelAnchor } from "@d3gl/labels";
import type { ViewTransform } from "@d3gl/core";
import type { TreeNode } from "./tree.js";
import { layoutRectangular, layoutRadial, nodeXY, type LayoutMode } from "./layout.js";
import { makeMammalTree, assignBioregions, REGION_NAMES } from "./mammals-data.js";
import { calcMaximumParsimony, aggregateSpeciesCount } from "./parsimony.js";

const W = 900;
const H = 600;
const CX = W / 2;
const CY = H / 2;

type BackendType = "webgl" | "canvas" | "svg";
type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

const regionColor = scaleOrdinal<number, string>()
  .domain(REGION_NAMES.map((_, i) => i))
  .range(schemeCategory10 as string[]);

/** A single pie slice for one bioregion at one node. */
interface Wedge { cx: number; cy: number; r: number; a0: number; a1: number; clusterId: number; node: PNode; }

/** Link path generator for the current layout (rectangular d3.link, radial step/bump). */
function makeLinkDraw(mode: LayoutMode): (ctx: CanvasRenderingContext2D, l: PLink) => void {
  if (mode === "rectangular") {
    const gen = d3link<PLink, PNode>(curveStepBefore).x((d) => d.y).y((d) => d.x);
    return (ctx, l) => { gen.context(ctx); gen(l); };
  }
  const gen = linkRadial<PLink, PNode>().angle((d) => d.x).radius((d) => d.y);
  return (ctx, l) => { gen.context(ctx); gen(l); };
}

/** Pie wedges for every node worth drawing: all tips (current distribution) plus internal
 *  nodes whose subtree is large enough to be legible (LOD cull for big trees). */
function buildWedges(nodes: PNode[], mode: LayoutMode, totalTips: number): Wedge[] {
  const threshold = Math.max(2, Math.floor(totalTips * 0.01));
  const wedges: Wedge[] = [];
  for (const n of nodes) {
    const isTip = !n.children;
    if (!isTip && (n.data.speciesCount ?? 0) < threshold) continue;
    const set = n.data.ranges?.clusters ?? [];
    if (set.length === 0) continue;
    const [cx, cy] = nodeXY(n, mode);
    const r = isTip ? 4 : 6.5;
    const tot = set.reduce((s, c) => s + c.count, 0) || 1;
    let a = -Math.PI / 2;
    for (const c of set) {
      const a1 = a + (c.count / tot) * Math.PI * 2;
      wedges.push({ cx, cy, r, a0: a, a1, clusterId: c.clusterId, node: n });
      a = a1;
    }
  }
  return wedges;
}

function labelTransform(mode: LayoutMode, angle: number, gap: number): string {
  if (mode !== "radial") return `translate(${gap}px, -50%)`;
  const deg = (angle * 180) / Math.PI - 90;
  return Math.sin(angle) < 0
    ? `rotate(${deg + 180}deg) translate(${-gap}px, -50%) translate(-100%, 0)`
    : `rotate(${deg}deg) translate(${gap}px, -50%)`;
}

export function InfomapBioregions(): React.ReactElement {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("radial");
  const [backend, setBackend] = useState<BackendType>("webgl");
  const [tips, setTips] = useState(256);
  const [thickness, setThickness] = useState(true);
  const [pies, setPies] = useState(true);
  const [tooltip, setTooltip] = useState<{ left: number; top: number; text: string } | null>(null);

  const chartRef = useRef<Plot | null>(null);
  const labelLayerRef = useRef<LabelLayer | null>(null);
  const transformRef = useRef<ViewTransform>({ k: 1, x: 0, y: 0 });
  const hostRef = useRef<HTMLDivElement>(null);
  const labelContainerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef<LabelAnchor[]>([]);
  const zoomBehaviorRef = useRef<ReturnType<typeof d3zoom<HTMLDivElement, unknown>> | null>(null);

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
      const names = (w.node.data.ranges?.clusters ?? []).map((c) => REGION_NAMES[c.clusterId] ?? `#${c.clusterId}`);
      const kind = w.node.children ? "ancestral range" : "distribution";
      setTooltip({
        left: ev.clientX - r.left + 12,
        top: ev.clientY - r.top + 12,
        text: `${w.node.data.name} · ${kind}: ${names.join(", ")}`,
      });
    });

    const zoomBehavior = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.4, 120])
      .on("zoom", (e: D3ZoomEvent<HTMLDivElement, unknown>) => {
        const t = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        transformRef.current = t;
        chart.setTransform(t);
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

    // Build the tree, reconstruct ancestral ranges (Fitch) and subtended-terminal counts.
    const tree = makeMammalTree(tips, 1);
    const cps = assignBioregions(tree, REGION_NAMES.length, 1);
    calcMaximumParsimony(tree, cps);
    aggregateSpeciesCount(tree);

    const root = layoutMode === "rectangular"
      ? layoutRectangular(tree, W, H, "linear")
      : layoutRadial(tree, W, H, "linear");
    const nodes = root.descendants();
    const links = root.links();
    const tipNodes = root.leaves();

    const base = layoutMode === "radial" ? zoomIdentity.translate(CX, CY) : zoomIdentity;
    const baseT: ViewTransform = { k: base.k, x: base.x, y: base.y };
    select(wrapper).call(zoomBehavior.transform, base);
    transformRef.current = baseT;

    const GAP = 8;
    const anchors: LabelAnchor[] = tipNodes.map((n, i) => {
      const [px, py] = nodeXY(n, layoutMode);
      return {
        id: `t${i}`, refX: px, refY: py, text: n.data.name,
        width: n.data.name.length * 6.2 + 6, height: 14,
        priority: n.data.speciesCount ?? 1,
        transformOrigin: "0 0", transform: labelTransform(layoutMode, n.x, GAP),
      };
    });
    anchorsRef.current = anchors;

    // Branch thickness ∝ subtended terminals (Fig. 3 caption).
    const widthScale = scaleSqrt().domain([1, root.data.speciesCount ?? 1]).range([0.4, 6]);
    const drawLink = makeLinkDraw(layoutMode);
    chart.layer("links", links, {
      draw: (ctx, l) => drawLink(ctx, l),
      stroke: "#777",
      lineWidth: thickness ? (l: PLink) => widthScale(l.target.data.speciesCount ?? 1) : 0.8,
    });

    const wedges = pies ? buildWedges(nodes, layoutMode, tips) : [];
    chart.layer("pies", wedges, {
      draw: (ctx, w) => { ctx.moveTo(w.cx, w.cy); ctx.arc(w.cx, w.cy, w.r, w.a0, w.a1); ctx.closePath(); },
      fill: (w: Wedge) => regionColor(w.clusterId),
      stroke: "#fff",
      lineWidth: 0.4,
      id: (_w, i) => i,
    });

    chart.setTransform(baseT);
    labelLayer.update(anchors, baseT, { width: W, height: H });
  }, [layoutMode, tips, thickness, pies]);

  const exportPNG = (): void => {
    try { download(chartRef.current!.toPNG(), "bioregions-tree.png"); }
    catch { alert("PNG export needs the WebGL or Canvas backend."); }
  };
  const exportSVG = (): void => {
    download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(chartRef.current?.toSVG() ?? "")}`, "bioregions-tree.svg");
  };

  const btn = (active: boolean) => ({
    padding: "3px 9px", fontSize: 13, borderRadius: 5, cursor: active ? "default" : "pointer",
    border: "1px solid #ccc", background: active ? "#1a73e8" : "#fff", color: active ? "#fff" : "#222",
  });

  return (
    <div style={{ padding: 16, color: "#222" }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 4px" }}>
        Infomap Bioregions — mammal tree with ancestral ranges ({layoutMode}, {tips} species)
      </h1>
      <p style={{ margin: "0 0 12px", fontSize: 12, opacity: 0.7 }}>
        Pie charts show the bioregion distribution (current at tips, Fitch-reconstructed ancestral range at internal nodes);
        branch thickness ∝ number of subtended species — a standalone recreation of Fig. 3a.
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
      <p style={{ opacity: 0.6, fontSize: 12 }}>scroll to zoom · drag to pan · hover a pie for the species and its ranges</p>
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
