import React, { useEffect, useRef, useState } from "react";
import { schemeCategory10 } from "d3-scale-chromatic";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent, zoomIdentity } from "d3-zoom";
import { plot, type Plot } from "@d3gl/map";
import type { HoverHit } from "@d3gl/map";
import { LabelLayer } from "@d3gl/labels";
import type { LabelAnchor } from "@d3gl/labels";
import type { PathContext } from "@d3gl/core";
import type { ViewTransform } from "@d3gl/core";
import { makeTree } from "./tree.js";
import { layoutRectangular, layoutRadial } from "./layout.js";
import type { HierarchyNode, HierarchyLink } from "d3-hierarchy";
import type { TreeNode } from "./tree.js";

const W = 900;
const H = 600;

type LayoutMode = "rectangular" | "radial";
type BackendType = "webgl" | "canvas" | "svg";

// Typed augmented node
interface AugNode extends HierarchyNode<TreeNode> {
  px: number;
  py: number;
  dist: number;
  angle?: number;
  radius?: number;
}

type AugLink = HierarchyLink<TreeNode> & {
  source: AugNode;
  target: AugNode;
};

const CX = W / 2;
const CY = H / 2;

function drawLink(ctx: PathContext, link: AugLink, mode: LayoutMode): void {
  const s = link.source;
  const t = link.target;
  if (mode === "rectangular") {
    // Elbow: vertical at the parent depth, then out to the child.
    ctx.moveTo(s.px, s.py);
    ctx.lineTo(s.px, t.py);
    ctx.lineTo(t.px, t.py);
  } else {
    // Radial step: arc along the PARENT radius from parent angle to child angle,
    // then a radial line out to the child — a clean radial dendrogram (no crossings).
    const sr = s.radius ?? 0;
    const sa = s.angle ?? 0;
    const ta = t.angle ?? 0;
    const tr = t.radius ?? 0;
    const steps = Math.max(1, Math.ceil(Math.abs(ta - sa) / 0.12));
    ctx.moveTo(CX + sr * Math.cos(sa), CY + sr * Math.sin(sa));
    for (let i = 1; i <= steps; i++) {
      const a = sa + ((ta - sa) * i) / steps;
      ctx.lineTo(CX + sr * Math.cos(a), CY + sr * Math.sin(a));
    }
    ctx.lineTo(CX + tr * Math.cos(ta), CY + tr * Math.sin(ta));
  }
}

function dot(ctx: PathContext, px: number, py: number, r: number): void {
  ctx.arc(px, py, r, 0, 2 * Math.PI);
}

export function App(): React.ReactElement {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("rectangular");
  const [backend, setBackend] = useState<BackendType>("webgl");
  const [tips, setTips] = useState(128);
  const [tooltip, setTooltip] = useState<{ left: number; top: number; text: string } | null>(null);

  const chartRef = useRef<Plot | null>(null);
  const labelLayerRef = useRef<LabelLayer | null>(null);
  const transformRef = useRef<ViewTransform>({ k: 1, x: 0, y: 0 });
  const hostRef = useRef<HTMLDivElement>(null);
  const labelContainerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef<LabelAnchor[]>([]);

  // Initial mount: create plot engine + label layer + zoom behavior
  useEffect(() => {
    const host = hostRef.current;
    const labelContainer = labelContainerRef.current;
    const wrapper = wrapRef.current;
    if (!host || !labelContainer || !wrapper) return;

    const chart = plot(host, { width: W, height: H, backend });
    chartRef.current = chart;

    const labelLayer = new LabelLayer(labelContainer, (a) => a.text);
    labelLayerRef.current = labelLayer;

    // Manual d3-zoom on the wrapper div
    const zoomBehavior = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.5, 50])
      .on("zoom", (e: D3ZoomEvent<HTMLDivElement, unknown>) => {
        const t = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        transformRef.current = t;
        chart.setTransform(t);
        labelLayer.update(anchorsRef.current, t, { width: W, height: H });
      });
    select(wrapper as Element).call(zoomBehavior as any);

    return () => {
      chart.destroy();
      labelLayer.destroy();
      select(wrapper as Element).on(".zoom", null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch backend when backend state changes (after initial mount)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setBackend(backend);
  }, [backend]);

  // Rebuild layers when layout mode or tips count changes
  useEffect(() => {
    const chart = chartRef.current;
    const labelLayer = labelLayerRef.current;
    if (!chart || !labelLayer) return;

    const tree = makeTree(tips);
    const h =
      layoutMode === "rectangular"
        ? layoutRectangular(tree, W, H)
        : layoutRadial(tree, W, H);

    const nodes = h.descendants() as AugNode[];
    const links = h.links() as unknown as AugLink[];
    const tipNodes = nodes.filter((n) => !n.children);

    // Rebuild anchors for label layer
    // width/height drive collision culling — without them every label renders
    // (0×0 boxes never overlap). ~6.2px/char at the 11px label font, +a little pad.
    const anchors: LabelAnchor[] = tipNodes.map((n, i) => ({
      id: `t${i}`,
      refX: n.px,
      refY: n.py,
      text: n.data.name,
      width: n.data.name.length * 6.2 + 6,
      height: 14,
      priority: n.data.length,
    }));
    anchorsRef.current = anchors;

    // Re-add layers (preserves backend; transform preserved via transformRef)
    chart.layer("links", links, {
      draw: (ctx: PathContext, l: AugLink) => drawLink(ctx, l, layoutMode),
      stroke: "#8aa",
      lineWidth: 0.6,
    });

    chart.layer("nodes", tipNodes, {
      draw: (ctx: PathContext, n: AugNode) => dot(ctx, n.px, n.py, 2.2),
      fill: (n: AugNode) => schemeCategory10[n.data.group % 10] ?? "#888",
      id: (_n: AugNode, i: number) => `t${i}`,
    });

    // Restore zoom transform
    chart.setTransform(transformRef.current);

    // Setup hover
    chart.on("hover", (hit: HoverHit | null, ev: PointerEvent) => {
      const el = wrapRef.current;
      if (!hit || !el) { setTooltip(null); return; }
      const r = el.getBoundingClientRect();
      const left = ev.clientX - r.left + 12;
      const top = ev.clientY - r.top + 12;
      if (hit.layer === "nodes") {
        const node = hit.datum as AugNode | null;
        if (node) {
          setTooltip({ left, top, text: `${node.data.name} · len ${node.data.length.toFixed(3)}` });
        }
      } else {
        setTooltip(null);
      }
    });

    // Update labels with current transform
    labelLayer.update(anchors, transformRef.current, { width: W, height: H });
  }, [layoutMode, tips]);

  const exportPNG = (): void => {
    try { download(chartRef.current!.toPNG(), "phylotree.png"); }
    catch { alert("PNG export needs the WebGL or Canvas backend."); }
  };
  const exportSVG = (): void => {
    const svg = chartRef.current?.toSVG() ?? "";
    download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, "phylotree.svg");
  };

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>d3gl — phylogenetic tree ({backend}, {layoutMode}, {tips} tips)</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {(["webgl", "canvas", "svg"] as const).map((b) => (
          <button key={b} onClick={() => setBackend(b)} disabled={backend === b}>{b}</button>
        ))}
        <span style={{ width: 8 }} />
        <button onClick={() => setLayoutMode("rectangular")} disabled={layoutMode === "rectangular"}>Rectangular</button>
        <button onClick={() => setLayoutMode("radial")} disabled={layoutMode === "radial"}>Radial</button>
        <span style={{ width: 8 }} />
        <label style={{ fontSize: 13 }}>
          Tips: {tips}
          <input
            type="range"
            min={64}
            max={4096}
            step={64}
            value={tips}
            onChange={(e) => setTips(Number(e.target.value))}
            style={{ marginLeft: 8, verticalAlign: "middle" }}
          />
        </label>
        <span style={{ width: 8 }} />
        <button onClick={exportPNG}>Export PNG</button>
        <button onClick={exportSVG}>Export SVG</button>
      </div>

      {/* Wrapper: captures zoom events; plot host + label container overlap absolutely */}
      <div
        ref={wrapRef}
        style={{ position: "relative", width: W, height: H, background: "#0d1a1a", cursor: "crosshair", overflow: "hidden" }}
      >
        {/* Plot host: canvas/WebGL/SVG renders here */}
        <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
        {/* Label overlay: absolutely positioned over the canvas */}
        <div ref={labelContainerRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", fontSize: 11, lineHeight: "14px", color: "#dfe", textShadow: "0 1px 2px #000" }} />
        {tooltip && (
          <div style={{
            position: "absolute",
            left: tooltip.left,
            top: tooltip.top,
            pointerEvents: "none",
            background: "rgba(0,0,0,0.85)",
            border: "1px solid #444",
            borderRadius: 4,
            padding: "4px 8px",
            fontSize: 12,
            whiteSpace: "nowrap",
            zIndex: 10,
          }}>
            {tooltip.text}
          </div>
        )}
      </div>
      <p style={{ opacity: 0.6, fontSize: 12 }}>scroll to zoom · drag to pan · hover tip nodes for name</p>
    </div>
  );
}

function download(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href; a.download = filename; a.click();
}
