import { rgb } from "d3-color";
import type { InstancedCirclesData, InstancedLinesData } from "../core/index.js";
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
