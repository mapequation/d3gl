import React, { useEffect, useRef, useState } from "react";
import { schemeCategory10 } from "d3-scale-chromatic";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent, zoomIdentity } from "d3-zoom";
import { linkHorizontal, linkRadial } from "d3-shape";
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
  angle?: number;
  radius?: number;
}

type AugLink = HierarchyLink<TreeNode> & {
  source: AugNode;
  target: AugNode;
};

const CX = W / 2;
const CY = H / 2;

export function PhyloTree(): React.ReactElement {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("rectangular");
  const [backend, setBackend] = useState<BackendType>("webgl");
  const [tips, setTips] = useState(128);
  const [markerMode, setMarkerMode] = useState<"world" | "screen">("world");
  const [tooltip, setTooltip] = useState<{ left: number; top: number; text: string } | null>(null);

  const chartRef = useRef<Plot | null>(null);
  const labelLayerRef = useRef<LabelLayer | null>(null);
  const transformRef = useRef<ViewTransform>({ k: 1, x: 0, y: 0 });
  const hostRef = useRef<HTMLDivElement>(null);
  const labelContainerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef<LabelAnchor[]>([]);
  // Store zoom behavior ref so we can reset transform on layout switch
  const zoomBehaviorRef = useRef<ReturnType<typeof d3zoom<HTMLDivElement, unknown>> | null>(null);

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

    // Register hover once (re-registering on every rebuild leaks listeners). pick()
    // always uses the engine's current layers, so this stays correct across rebuilds.
    chart.on("hover", (hit: HoverHit | null, ev: PointerEvent) => {
      const el = wrapRef.current;
      if (!hit || hit.layer !== "nodes" || !el) { setTooltip(null); return; }
      const node = hit.datum as AugNode | null;
      if (!node) { setTooltip(null); return; }
      const r = el.getBoundingClientRect();
      setTooltip({
        left: ev.clientX - r.left + 12,
        top: ev.clientY - r.top + 12,
        text: `${node.data.name} · branch ${node.data.length.toFixed(3)}`,
      });
    });

    // Manual d3-zoom on the wrapper div
    const zoomBehavior = d3zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.5, 50])
      .on("zoom", (e: D3ZoomEvent<HTMLDivElement, unknown>) => {
        const t = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        transformRef.current = t;
        chart.setTransform(t);
        labelLayer.update(anchorsRef.current, t, { width: W, height: H });
      });
    zoomBehaviorRef.current = zoomBehavior;
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
    const wrapper = wrapRef.current;
    const zoomBehavior = zoomBehaviorRef.current;
    if (!chart || !labelLayer || !wrapper || !zoomBehavior) return;

    const tree = makeTree(tips);
    const h =
      layoutMode === "rectangular"
        ? layoutRectangular(tree, W, H)
        : layoutRadial(tree, W, H);

    const nodes = h.descendants() as AugNode[];
    const links = h.links() as unknown as AugLink[];
    const tipNodes = nodes.filter((n) => !n.children);

    // Reset zoom base transform on layout switch:
    // - Rectangular: identity (world coords are canvas coords)
    // - Radial: translate(CX, CY) so origin-centred coords render centred on screen
    const baseTransform =
      layoutMode === "radial"
        ? zoomIdentity.translate(CX, CY)
        : zoomIdentity;
    const baseT: ViewTransform = { k: baseTransform.k, x: baseTransform.x, y: baseTransform.y };
    select(wrapper as Element).call((zoomBehavior as any).transform, baseTransform);
    transformRef.current = baseT;

    // Build d3-shape link generators bound to PathContext.
    // linkHorizontal / linkRadial call moveTo + bezierCurveTo on the context.
    const rectLink = linkHorizontal<AugLink, AugNode>()
      .x((d) => d.px)
      .y((d) => d.py);
    const radLink = linkRadial<AugLink, AugNode>()
      .angle((d) => d.angle ?? 0)
      .radius((d) => d.radius ?? 0);

    // Rebuild anchors for label layer
    // width/height drive collision culling — without them every label renders
    // (0×0 boxes never overlap). ~6.2px/char at the 11px label font, +a little pad.
    const GAP = 6;
    const anchors: LabelAnchor[] = tipNodes.map((n, i) => {
      const base = {
        id: `t${i}`,
        refX: n.px,
        refY: n.py,
        text: n.data.name,
        width: n.data.name.length * 6.2 + 6,
        height: 14,
        priority: n.data.length,
        transformOrigin: "0 0",
      };
      if (layoutMode === "radial") {
        const a = n.angle ?? 0;
        const deg = (a * 180) / Math.PI;
        // Left half: flip 180° (keeps text upright) and anchor the right edge, so the
        // label reads outward away from the centre — same trick as d3's radial-tree.
        const onLeft = Math.cos(a) < 0;
        const transform = onLeft
          ? `rotate(${deg + 180}deg) translate(${-GAP}px, -50%) translate(-100%, 0)`
          : `rotate(${deg}deg) translate(${GAP}px, -50%)`;
        return { ...base, transform };
      }
      // Rectangular: start just to the right of the tip, vertically centred.
      return { ...base, transform: `translate(${GAP}px, -50%)` };
    });
    anchorsRef.current = anchors;

    // Pick the appropriate generator once per layout rebuild, then bind its
    // rendering context per draw call. d3-shape's .context() types expect
    // CanvasRenderingContext2D, but PathContext is a structural subset that
    // d3-shape actually uses — cast once here rather than on every draw call.
    type CtxGen = { context(ctx: PathContext): { (d: AugLink): void } };
    const gen: CtxGen =
      layoutMode === "rectangular"
        ? (rectLink as unknown as CtxGen)  // linkHorizontal: cubic bezier elbow
        : (radLink as unknown as CtxGen);  // linkRadial: cubic bezier in polar

    // Re-add layers (preserves backend; transform set above)
    chart.layer("links", links, {
      // Each draw call receives a fresh PathContext for its drawable path.
      // Binding .context(ctx) routes moveTo / bezierCurveTo into d3gl's renderer.
      draw: (ctx: PathContext, l: AugLink) => gen.context(ctx)(l),
      stroke: "#8aa",
      lineWidth: 0.6,
    });

    chart.points("nodes", tipNodes, {
      x: (n: AugNode) => n.px,
      y: (n: AugNode) => n.py,
      radius: markerMode === "screen" ? 3.5 : 2.6,
      sizeMode: markerMode, // "world" scales with zoom; "screen" stays constant like labels
      fill: (n: AugNode) => schemeCategory10[n.data.group % 10] ?? "#888",
      id: (_n: AugNode, i: number) => `t${i}`,
    });

    // Apply the base transform to the engine
    chart.setTransform(baseT);

    // Update labels with base transform
    labelLayer.update(anchors, baseT, { width: W, height: H });
  }, [layoutMode, tips, markerMode]);

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
        <button onClick={() => setMarkerMode((m) => (m === "world" ? "screen" : "world"))}>
          markers: {markerMode}
        </button>
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
