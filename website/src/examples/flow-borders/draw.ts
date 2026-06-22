import { network, buildGraph } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { buildReplica, REPLICA_BOUNDS, NODE_FILL, BORDER_COLOR, LINK_COLOR } from "./data.js";

const BENDS = [0, 0.1, 0.18, 0.28, 0.4]; // the Bend slider's stops

/**
 * The **flow-border + bent half-arrow** glyph style (the `network-rendering` look), shown on a tiny
 * two-node network **without LOD** — so it's clear these are plain rendering features. Node fill/size
 * encode **total flow**; the ring around each node encodes its **enter/exit (boundary) flow**
 * (`flowBorder`); reciprocal directed links are **bent half-arrows** whose width encodes link flow and
 * which bow to opposite sides so they don't overlap. Switch the **backend** (WebGL / Canvas / SVG) —
 * the render is equivalent — export, go fullscreen, scroll to zoom, and drag the **Bend** slider.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  const { minX, maxX, minY, maxY } = REPLICA_BOUNDS;
  const k = Math.min(width / (maxX - minX), height / (maxY - minY)) * 0.9;
  net.setTransform({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k });
  net.enableZoom([k * 0.3, k * 12]);

  const g = buildReplica();
  const graph = buildGraph({ nodeCount: g.nodeCount, source: g.source, target: g.target, weight: g.weight, directed: true, nodeFlow: g.flow });
  net.data(graph).layout({ backend: "positions", positions: g.positions });

  return {
    engine: net,
    render: (options) => {
      const bend = BENDS[(options.bend as number) ?? 2] ?? 0.18;
      // World sizing: the reference is a fixed publication layout; radii/widths are world units.
      net.style({
        directed: true,
        nodeRadius: { by: "flow", scale: scaleSqrt().domain([0, 1]).range([0, 30]) }, // fill/size ∝ total flow
        nodeFill: (i) => NODE_FILL[i]!,
        flowBorder: { flow: g.enterExit, scale: scaleSqrt().domain([0, 1]).range([0, 6]), color: BORDER_COLOR }, // ring ∝ enter/exit flow
        linkBend: bend,
        linkStroke: LINK_COLOR,
        linkWidth: scaleSqrt().domain([0, 1]).range([0, 13]), // bent half-arrow width ∝ link flow
        arrowSize: 7,
        arrowFill: LINK_COLOR,
      });
    },
  };
};
