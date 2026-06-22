import { network, buildGraph } from "@mapequation/d3gl/network";
import type { ImperativeSetup } from "../types.js";
import { generateSierpinski, SIERPINSKI_BOUNDS, MODULE_PALETTE } from "./data.js";

const DEPTHS = [2, 3, 4, 5, 6]; // 27 → 2187 nodes

/**
 * **Modular-aware level of detail.** An undirected Sierpinski gasket whose recursive subdivision *is*
 * a planted module hierarchy (Infomap-style `path` per node), fed to `net.lod({ modules })`. Each node
 * is coloured by its **top-level module** (a categorical palette), so a module glyph and all its leaves
 * share one colour. Zoom out and nodes **aggregate into their parent module**; zoom in and modules
 * expand → sub-modules → leaf triangles — the colour stays, so you can read the hierarchy at any scale.
 * Links are simple bent lines (undirected, no arrows). Scroll to zoom, drag to pan; the Depth slider
 * grows the gasket from 27 to 2,187 nodes.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.05, 60]);
  // Frame the gasket's fixed world bounds once (render() never touches the transform).
  const { minX, maxX, minY, maxY } = SIERPINSKI_BOUNDS;
  const k = Math.min(width / (maxX - minX), height / (maxY - minY)) * 0.9;
  net.setTransform({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k });

  return {
    engine: net,
    render: (options) => {
      const depth = DEPTHS[(options.depth as number) ?? 2] ?? 4;
      const lod = options.lod !== "Off";
      const { nodeCount, source, target, weight, positions, modules } = generateSierpinski(depth);
      const graph = buildGraph({ nodeCount, source, target, weight });
      const moduleColor = (i: number) => MODULE_PALETTE[(modules[i]!.path[0]! - 1) % MODULE_PALETTE.length]!;

      net
        .data(graph)
        .style({
          sizeMode: "screen",
          nodeRadius: 5,
          nodeFill: moduleColor, // categorical by top-level module → aggregates keep the colour
          nodeBorder: { width: 1, color: "#ffffff" },
          linkBend: 0.18, // bent lines (undirected — no arrowheads)
          linkStroke: "rgba(90,100,120,0.6)",
          linkWidth: 2,
        })
        .lod(lod ? { modules, expandPx: 120, maxAggregateRadius: 26 } : false)
        .layout({ backend: "positions", positions });
    },
  };
};
