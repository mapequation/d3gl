import React, { useEffect, useRef, useState } from "react";
import { schemeCategory10 } from "d3-scale-chromatic";
import { scaleSqrt } from "d3-scale";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent, zoomIdentity } from "d3-zoom";
import { link as d3link, linkRadial, curveLinear, curveStepBefore, curveBumpX, pointRadial } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { plot, type Plot, type HoverHit } from "@d3gl/map";
import { LabelLayer, type LabelAnchor } from "@d3gl/labels";
import type { ViewTransform } from "@d3gl/core";
import { makeTree, type TreeNode } from "./tree.js";
import { layoutRectangular, layoutRadial, nodeXY, type LayoutMode, type TimeScaleKind } from "./layout.js";

const W = 900;
const H = 600;
const CX = W / 2;
const CY = H / 2;

type BackendType = "webgl" | "canvas" | "svg";
type CurveMode = "linear" | "step" | "bump";
type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

/**
 * A link renderer for the current layout + curve. Rectangular uses `d3.link(curve)`
 * (a d3-shape generator) drawing straight into the d3gl context. Radial uses
 * `d3.linkRadial()` for the smooth "bump", a straight Cartesian line for "linear",
 * and a hand-built arc-then-radial elbow for "step" (the crisp right-angle look).
 */
function makeLinkDraw(mode: LayoutMode, curve: CurveMode): (ctx: CanvasRenderingContext2D, l: PLink) => void {
  if (mode === "rectangular") {
    const factory = curve === "linear" ? curveLinear : curve === "step" ? curveStepBefore : curveBumpX;
    const gen = d3link<PLink, PNode>(factory).x((d) => d.y).y((d) => d.x); // x=time depth, y=leaf row
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
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
    };
  }
  // radial "step": a circular arc along the parent radius from the parent angle to the
  // child angle, then a radial line out to the child. pointRadial's screen angle is
  // (angle - π/2). Use the built-in ctx.arc (flattened consistently across backends);
  // anticlockwise = ta < sa sweeps the short way to the child.
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

/** Rotation/centering only; the constant-px gap from the tip is the LabelAnchor `offset`. */
function labelTransform(mode: LayoutMode, angle: number): string {
  if (mode !== "radial") return "";
  const deg = (angle * 180) / Math.PI - 90; // pointRadial's 0 = north; align with the radius
  return Math.sin(angle) < 0
    ? `rotate(${deg + 180}deg) translate(-100%, -50%)`
    : `rotate(${deg}deg) translate(0, -50%)`;
}
/** Constant screen-px offset: rightward (rectangular) or outward along the radius (radial). */
function labelOffset(mode: LayoutMode, angle: number, gap: number, height: number): [number, number] {
  if (mode !== "radial") return [gap, -height / 2];
  const a = angle - Math.PI / 2;
  return [Math.cos(a) * gap, Math.sin(a) * gap];
}

export function PhyloTree(): React.ReactElement {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("rectangular");
  const [backend, setBackend] = useState<BackendType>("webgl");
  const [curve, setCurve] = useState<CurveMode>("step");
  const [timeScale, setTimeScale] = useState<TimeScaleKind>("linear");
  const [tips, setTips] = useState(128);
  const [sizeMode, setSizeMode] = useState<"world" | "screen">("screen");
  const [thickness, setThickness] = useState(false);
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
      if (!hit || hit.layer !== "nodes" || !el) { setTooltip(null); return; }
      const node = hit.datum as PNode | null;
      if (!node) { setTooltip(null); return; }
      const r = el.getBoundingClientRect();
      setTooltip({
        left: ev.clientX - r.left + 12,
        top: ev.clientY - r.top + 12,
        text: `${node.data.name} · branch ${node.data.length.toFixed(3)}`,
      });
    });

    const zoomBehavior = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.4, 80])
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

  // Rebuild geometry when anything affecting layout/style changes.
  useEffect(() => {
    const chart = chartRef.current;
    const labelLayer = labelLayerRef.current;
    const wrapper = wrapRef.current;
    const zoomBehavior = zoomBehaviorRef.current;
    if (!chart || !labelLayer || !wrapper || !zoomBehavior) return;

    const root = layoutMode === "rectangular"
      ? layoutRectangular(makeTree(tips), W, H, timeScale)
      : layoutRadial(makeTree(tips), W, H, timeScale);
    const links = root.links();            // HierarchyPointLink<TreeNode>[] — no cast
    const tipNodes = root.leaves();        // HierarchyPointNode<TreeNode>[]

    // Radial coords are origin-centred → centre the view by translating to (CX, CY).
    const base = layoutMode === "radial" ? zoomIdentity.translate(CX, CY) : zoomIdentity;
    const baseT: ViewTransform = { k: base.k, x: base.x, y: base.y };
    select(wrapper).call(zoomBehavior.transform, base);
    transformRef.current = baseT;

    const GAP = 7;
    const H_LBL = 14;
    const anchors: LabelAnchor[] = tipNodes.map((n, i) => {
      const [px, py] = nodeXY(n, layoutMode);
      return {
        id: `t${i}`,
        refX: px,
        refY: py,
        text: n.data.name,
        width: n.data.name.length * 6.2 + 6,
        height: H_LBL,
        priority: n.data.length,
        transformOrigin: "0 0",
        offset: labelOffset(layoutMode, n.x, GAP, H_LBL),
        transform: labelTransform(layoutMode, n.x),
      };
    });
    anchorsRef.current = anchors;

    // Branch width ∝ number of subtended leaves (toggle); constant px in "screen" sizeMode.
    const widthScale = scaleSqrt().domain([1, tips]).range([0.6, 8]);
    const drawLink = makeLinkDraw(layoutMode, curve);
    chart.layer("links", links, {
      draw: (ctx, l) => drawLink(ctx, l), // ctx is CanvasRenderingContext2D — d3 generators accept it directly
      stroke: "#555",
      lineWidth: thickness ? (l: PLink) => widthScale(l.target.leaves().length) : 0.8,
      sizeMode,
    });
    chart.points("nodes", tipNodes, {
      x: (n) => nodeXY(n, layoutMode)[0],
      y: (n) => nodeXY(n, layoutMode)[1],
      radius: sizeMode === "screen" ? 3.2 : 2.6,
      sizeMode,
      fill: (n) => schemeCategory10[n.data.group % 10] ?? "#888",
      id: (_n, i) => `t${i}`,
    });
    chart.setTransform(baseT);
    labelLayer.update(anchors, baseT, { width: W, height: H });
  }, [layoutMode, tips, sizeMode, thickness, curve, timeScale]);

  const exportPNG = (): void => {
    try { download(chartRef.current!.toPNG(), "phylotree.png"); }
    catch { alert("PNG export needs the WebGL or Canvas backend."); }
  };
  const exportSVG = (): void => {
    download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(chartRef.current?.toSVG() ?? "")}`, "phylotree.svg");
  };

  const btn = (active: boolean) => ({
    padding: "3px 9px", fontSize: 13, borderRadius: 5, cursor: active ? "default" : "pointer",
    border: "1px solid #ccc", background: active ? "#1a73e8" : "#fff", color: active ? "#fff" : "#222",
  });

  return (
    <div style={{ padding: 16, color: "#222" }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 12px" }}>
        Phylogenetic tree — {layoutMode}, {curve} links, {timeScale} time, {tips} tips
      </h1>
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
        {(["linear", "log"] as const).map((s) => (
          <button key={s} style={btn(timeScale === s)} onClick={() => setTimeScale(s)}>{s} time</button>
        ))}
        <Sep />
        <button style={btn(thickness)} onClick={() => setThickness((v) => !v)}>thickness</button>
        <button style={btn(false)} onClick={() => setSizeMode((m) => (m === "world" ? "screen" : "world"))}>
          size: {sizeMode}
        </button>
        <Sep />
        <label style={{ fontSize: 13 }}>
          tips {tips}
          <input type="range" min={64} max={4096} step={64} value={tips}
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
      <p style={{ opacity: 0.6, fontSize: 12 }}>scroll to zoom · drag to pan · hover a tip for its name</p>
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
