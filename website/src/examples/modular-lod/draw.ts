import { network, buildGraph, moduleColors, type NetworkLinkHit } from "@mapequation/d3gl/network";
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
 * `members()` — the **leaf node ids inside a clicked module aggregate** — shown in the caption. With a
 * **multi**-selectable lane, **shift+drag** draws a **marquee** (#159) that adds every node/aggregate
 * whose centre falls in the box (a CPU range query over the frontier — no extra setup; plain drag pans);
 * the covered glyphs preview with the hover ring as you drag.
 *
 * `net.pickLinks()` adds **pixel-exact link picking** (#141, WebGL): the links are thin bent strips, so
 * resolving "the link you see" uses a GPU-readback pass behind the same pick seam. Hover a link (or a
 * super-edge between two collapsed modules) and the caption reports its endpoints — `on("hover")` gets a
 * hit with `layer: "links"` and a `NetworkLinkHit` datum. Nodes are drawn on top, so they win where they overlap.
 *
 * `net.labels({ labelOf })` adds **frontier labels** (#105 N7b): a size badge on every visible module
 * aggregate (here `labelOf` returns null for leaves, and no `max` is set — on a symmetric gasket showing
 * all modules reads clearer than an arbitrary top-k), re-placed on pan/zoom. Scroll to zoom, drag to
 * pan; the Depth slider grows the gasket from 27 to 2,187 nodes.
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
  const HINT = "Hover to ring · hover a link to inspect · click to select (⇧/⌘ adds) · ⇧+drag to box-select";
  caption.textContent = HINT;
  host.appendChild(caption);

  // Current selection summary (members() = the leaf node ids each glyph covers) — the caption falls back
  // to this when nothing is being hovered, so a transient link readout restores it on pointer-out.
  const selectionText = (): string => {
    const hits = net.selection();
    if (hits.length === 0) return HINT;
    const leaves = hits.flatMap((h) => h.members?.() ?? []);
    const sample = leaves.slice(0, 12).join(", ");
    return `Selected ${hits.length} glyph${hits.length > 1 ? "s" : ""} covering ${leaves.length} leaf node${leaves.length > 1 ? "s" : ""}: ${sample}${leaves.length > 12 ? ", …" : ""}`;
  };

  // Selection + hover ring for nodes/aggregates (#105 N7c-2) + pixel-exact link picking (#141).
  net
    // hover ring blue, selection ring orange (the white default hover ring is for dark backgrounds).
    .interactive({ selectable: { multi: true }, hover: { stroke: "#2563eb" }, selection: { selected: { stroke: "#ff6a00" } } })
    .pickLinks() // GPU-readback: hover/click now also resolves links (layer: "links"), not just nodes
    .on("select", () => { caption.textContent = selectionText(); })
    .on("hover", (hit) => {
      // A link hit (the cursor is over a link/super-edge and not over a node, which wins): show its
      // endpoints; off a link, restore the selection summary (or the hint).
      if (hit?.layer === "links") {
        const { source, target, aggregate } = hit.datum as NetworkLinkHit;
        caption.textContent = `${aggregate ? "Super-edge" : "Link"} ${source} – ${target}`;
      } else {
        caption.textContent = selectionText();
      }
    });

  // Frontier labels (#105 N7b): a size badge on EVERY visible module aggregate (no `max` — the gasket is
  // symmetric, so showing all reads clearer than an arbitrary top-k; `labelOf` returns null for leaves,
  // so only modules are badged). Re-placed (and re-picked) as you pan/zoom.
  const labelStyle = document.createElement("style");
  labelStyle.textContent = ".lod-label{font:600 11px/1 system-ui,sans-serif;color:#1f2937;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff}";
  host.appendChild(labelStyle);
  net.labels({ className: "lod-label", labelOf: (id, info) => (info.aggregate ? `${info.count}` : null) });

  return {
    engine: net,
    dispose: () => { caption.remove(); labelStyle.remove(); },
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
