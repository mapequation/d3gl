import { network, buildGraph } from "@mapequation/d3gl/network";
import { scaleLinear } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { buildReplica, REPLICA_BOUNDS, NODE_FILL_RANGE, NODE_BORDER_RANGE, LINK_RANGE } from "./data.js";

const BENDS = [0, 15, 30, 45, 60]; // the Bend slider's stops (absolute world-unit ⟂ offset)

/**
 * The **flow-border + half-arrow** glyph style (the `network-rendering` look), shown on the reference
 * two-node network **without LOD** — so it's clear these are plain rendering features. The planted
 * **flow** model drives every channel through a d3 scale: node total flow → fill colour + radius,
 * enter/exit flow → ring width + colour, link flow → half-arrow width + colour. With
 * `linkStyle: "half-arrow"` each directed link is one filled shape that pinches to the source centre
 * and lands its barbed tip on the target node's boundary; a reciprocal pair nests around a shared
 * centre curve. Switch the **backend** (WebGL / Canvas / SVG) — the render is equivalent — export, go
 * fullscreen, scroll to zoom, and drag the **Bend** slider.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  const { minX, maxX, minY, maxY } = REPLICA_BOUNDS;
  const k = Math.min(width / (maxX - minX), height / (maxY - minY)) * 0.95;
  net.setTransform({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k });
  net.enableZoom([k * 0.3, k * 12]);

  const g = buildReplica();
  const graph = buildGraph({ nodeCount: g.nodeCount, source: g.source, target: g.target, weight: g.weight, directed: true, nodeFlow: g.flow });
  net.data(graph).layout({ backend: "positions", positions: g.positions });

  // d3 scales over the planted flow, with the reference's domains & ranges (range minimums ≥ 1 so
  // nothing vanishes at low flow). Colour ranges interpolate in RGB, as in the reference.
  const fillColor = scaleLinear<string>().domain([0.4, 0.6]).range(NODE_FILL_RANGE);
  const radius = scaleLinear().domain([0.4, 0.6]).range([20, 30]);
  const borderColor = scaleLinear<string>().domain([0.2, 0.3]).range(NODE_BORDER_RANGE);
  const borderWidth = scaleLinear().domain([0.2, 0.3]).range([3, 6]);
  const linkColor = scaleLinear<string>().domain([0.3, 0.5]).range(LINK_RANGE);
  const linkWidth = scaleLinear().domain([0.3, 0.5]).range([7, 13]);

  return {
    engine: net,
    render: (options) => {
      const bend = BENDS[(options.bend as number) ?? 2] ?? 30;
      // World sizing: the reference is a fixed publication layout; radii/widths are world units.
      net.style({
        directed: true,
        linkStyle: "half-arrow",
        nodeRadius: { by: "flow", scale: radius }, // radius ∝ total flow
        nodeFill: (i) => fillColor(graph.flow![i]!), // fill ∝ total flow
        flowBorder: { flow: g.outFlow, scale: borderWidth, color: (v) => borderColor(v) }, // ring ∝ enter/exit flow
        linkBend: bend,
        linkWidth, // half-arrow width ∝ link flow
        linkStroke: linkColor, // half-arrow colour ∝ link flow
      });
    },
  };
};
