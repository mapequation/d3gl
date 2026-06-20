import { rgb } from "d3-color";
import type { InstancedCirclesData, InstancedLinesData, InstancedArrowsData, InstancedLayer } from "../core/index.js";
import type { NetworkGraph } from "./graph.js";

/**
 * Glyph builders for the network module (#100, epic #98) — the instanced "emitters".
 * Each glyph is defined once here and emitted to the instanced WebGL lane (this file)
 * or, later, to the PathContext seam for SVG/Canvas export (#100 N2.3).
 */

export interface NodeStyleResolved {
  radius: number;
  fill: string;
}

export interface LinkStyleResolved {
  width: number;
  stroke: string;
}

/** Parse any CSS colour to RGBA bytes (alpha from opacity). */
function toRGBA(css: string): [number, number, number, number] {
  const c = rgb(css);
  return [
    Math.round(c.r) & 255,
    Math.round(c.g) & 255,
    Math.round(c.b) & 255,
    Math.round((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255) & 255,
  ];
}

/** A per-instance RGBA buffer filled with one repeated colour. */
function fillColors(count: number, css: string): Uint8Array {
  const [r, g, b, a] = toRGBA(css);
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = a;
  }
  return colors;
}

/**
 * Instanced-circle data for a graph's nodes. Shares the graph's positions buffer as the
 * instance centres (no copy); radii/colours are constant for now (degree/flow scaling later).
 */
export function nodeCircles(graph: NetworkGraph, style: NodeStyleResolved): InstancedCirclesData {
  const count = graph.nodeCount;
  const radii = new Float32Array(count).fill(style.radius);
  return { centers: graph.positions, radii, colors: fillColors(count, style.fill), count };
}

/**
 * Instanced straight-line data for a graph's links, gathering each edge's endpoints from the
 * node positions by index. Rebuilt when positions change (it copies, unlike {@link nodeCircles}).
 */
export function linkLines(graph: NetworkGraph, style: LinkStyleResolved): InstancedLinesData {
  const count = graph.edgeCount;
  const sources = new Float32Array(count * 2);
  const targets = new Float32Array(count * 2);
  for (let e = 0; e < count; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    sources[e * 2] = graph.positions[s * 2]!;
    sources[e * 2 + 1] = graph.positions[s * 2 + 1]!;
    targets[e * 2] = graph.positions[t * 2]!;
    targets[e * 2 + 1] = graph.positions[t * 2 + 1]!;
  }
  const widths = new Float32Array(count).fill(style.width);
  return { sources, targets, widths, colors: fillColors(count, style.stroke), count };
}

export interface ArrowStyleResolved {
  size: number;
  nodeRadius: number;
  fill: string;
}

/**
 * Instanced arrowhead data for a directed graph's links. The tip sits `nodeRadius` back from
 * the target node's centre (so it meets the node boundary), oriented from the source.
 */
export function linkArrows(graph: NetworkGraph, style: ArrowStyleResolved): InstancedArrowsData {
  const count = graph.edgeCount;
  const sources = new Float32Array(count * 2);
  const targets = new Float32Array(count * 2);
  for (let e = 0; e < count; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    const sx = graph.positions[s * 2]!;
    const sy = graph.positions[s * 2 + 1]!;
    const tx = graph.positions[t * 2]!;
    const ty = graph.positions[t * 2 + 1]!;
    const dx = tx - sx;
    const dy = ty - sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    sources[e * 2] = sx;
    sources[e * 2 + 1] = sy;
    targets[e * 2] = tx - ux * style.nodeRadius;
    targets[e * 2 + 1] = ty - uy * style.nodeRadius;
  }
  const sizes = new Float32Array(count).fill(style.size);
  return { sources, targets, sizes, colors: fillColors(count, style.fill), count };
}

/** Fully-resolved network style (defaults applied) for assembling the render layers. */
export interface ResolvedNetworkStyle {
  nodeRadius: number;
  nodeFill: string;
  linkWidth: number;
  linkStroke: string;
  arrowSize: number;
  arrowFill: string;
  directed: boolean;
}

/**
 * Assemble the ordered instanced layers for a network: links (under), arrowheads (directed
 * only), then nodes (on top). Pure — the engine just pushes the result to the backend, which
 * keeps "what to render" unit-testable without a DOM or GPU.
 */
export function networkLayers(graph: NetworkGraph, style: ResolvedNetworkStyle): InstancedLayer[] {
  const layers: InstancedLayer[] = [];
  if (graph.edgeCount > 0) {
    layers.push({
      name: "links",
      primitive: "lines",
      lines: linkLines(graph, { width: style.linkWidth, stroke: style.linkStroke }),
      sizeMode: "world",
    });
    if (style.directed) {
      layers.push({
        name: "arrows",
        primitive: "arrows",
        arrows: linkArrows(graph, { size: style.arrowSize, nodeRadius: style.nodeRadius, fill: style.arrowFill }),
        sizeMode: "world",
      });
    }
  }
  layers.push({
    name: "nodes",
    primitive: "circles",
    circles: nodeCircles(graph, { radius: style.nodeRadius, fill: style.nodeFill }),
    sizeMode: "world",
  });
  return layers;
}
