import { network, buildGraph, moduleColors } from "@mapequation/d3gl/network";
import type { ImperativeSetup } from "../types.js";
import { generateSierpinski, SIERPINSKI_BOUNDS } from "./data.js";

const DEPTHS = [2, 3, 4, 5, 6]; // 27 → 2187 nodes

/**
 * **Modular-aware level of detail + aggregate inspection.** An undirected Sierpinski gasket whose
 * recursive subdivision *is* a planted module hierarchy (Infomap-style `path` per node), fed to
 * `net.lod({ modules })`. Each node is coloured by its **top-level module** (a categorical palette), so
 * a module glyph and all its leaves share one colour. Zoom out and nodes **aggregate into their parent
 * module**; zoom in and modules expand → sub-modules → leaf triangles — the colour stays, so you can
 * read the hierarchy at any scale.
 *
 * `net.interactive({ selectable, hover })` opts the nodes/aggregates into selection (#105 N7c-2):
 * **hover** shows a ring, **click** selects (shift/⌘-click adds), and `on("select")` reports each hit's
 * `members()` — the **leaf node ids inside a clicked module aggregate** — shown in the caption. Scroll
 * to zoom, drag to pan; the Depth slider grows the gasket from 27 to 2,187 nodes.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  // Frame the gasket's fixed world bounds once, BEFORE enableZoom — so d3-zoom seeds its internal
  // transform from this view and the first gesture doesn't snap back to identity. render() never
  // touches the transform.
  const { minX, maxX, minY, maxY } = SIERPINSKI_BOUNDS;
  const k = Math.min(width / (maxX - minX), height / (maxY - minY)) * 0.9;
  net.setTransform({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k });
  net.enableZoom([k * 0.3, k * 40]); // bracket the fit scale

  // A caption overlay that reports what the current selection covers. Built into the host so the code
  // tab stays pure d3gl + a tiny DOM readout. pointer-events:none so it never intercepts pan/zoom.
  const caption = document.createElement("div");
  caption.style.cssText = "position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);padding:4px 8px;font:12px/1.4 ui-monospace,monospace;color:#e5e7eb;background:rgba(17,24,39,0.72);border-radius:4px;pointer-events:none;white-space:pre-wrap";
  caption.textContent = "Hover to ring a node/module · click to select (⇧/⌘ adds)";
  host.appendChild(caption);

  // Selection + hover for nodes/aggregates. on("select") reads each hit's members() — the leaf node ids
  // the glyph covers (a single node for a leaf, the whole subtree for a collapsed module).
  net
    // hover ring blue, selection ring orange (the white default hover ring is for dark backgrounds).
    .interactive({ selectable: { multi: true }, hover: { stroke: "#2563eb" }, selection: { selected: { stroke: "#ff6a00" } } })
    .on("select", (hits) => {
      if (hits.length === 0) { caption.textContent = "Hover to ring a node/module · click to select (⇧/⌘ adds)"; return; }
      const leaves = hits.flatMap((h) => h.members?.() ?? []);
      const sample = leaves.slice(0, 12).join(", ");
      caption.textContent = `Selected ${hits.length} glyph${hits.length > 1 ? "s" : ""} covering ${leaves.length} leaf node${leaves.length > 1 ? "s" : ""}: ${sample}${leaves.length > 12 ? ", …" : ""}`;
    });

  return {
    engine: net,
    dispose: () => caption.remove(),
    render: (options) => {
      net.select("nodes", null); // a new graph/cut invalidates prior node ids — clear the selection
      const depth = DEPTHS[(options.depth as number) ?? 2] ?? 4;
      const lod = options.lod !== "Off";
      const { nodeCount, source, target, weight, positions, modules } = generateSierpinski(depth);
      const graph = buildGraph({ nodeCount, source, target, weight });
      // Hierarchical module colours: top modules split the hue circle, sub-modules vary within.
      const colors = moduleColors(modules);

      net
        .data(graph)
        .style({
          sizeMode: "screen",
          nodeRadius: 6,
          nodeFill: (i) => colors[i]!, // hierarchical module colour; LOD aggregates take their family hue
          nodeBorder: { width: 1, color: "#ffffff" },
          linkBend: 0.18, // bent lines (undirected — no arrowheads)
          linkStroke: "rgba(90,100,120,0.55)",
          // Uniform: every edge has weight 1 and bridges don't aggregate here, so links stay constant.
          // (linkWidth also accepts a (weight) => width scale; super-edges then size by accumulated weight.)
          linkWidth: 2.5,
        })
        // crossFade (#133): opt-in opacity cross-fade of a module ↔ its sub-modules across the expand
        // threshold (slider × 0.1 = band half-width). The self-similar gasket has no mixed-level frontier,
        // so crossLevelEdges (#139) doesn't apply here.
        .lod(lod ? { modules, expandPx: 120, maxAggregateRadius: 26, crossFade: ((options.crossFade as number) ?? 0) * 0.1 } : false)
        .layout({ backend: "positions", positions });
    },
  };
};
