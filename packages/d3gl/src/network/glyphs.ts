import { rgb } from "d3-color";
import type { InstancedCirclesData } from "../core/index.js";
import type { NetworkGraph } from "./graph.js";

/**
 * Glyph builders for the network module (#100, epic #98) — the "circles emitter".
 * Each glyph is defined once here and emitted to the instanced WebGL lane (this file)
 * or, later, to the PathContext seam for SVG/Canvas export (#100 N2.3).
 */

export interface NodeStyleResolved {
  radius: number;
  fill: string;
}

/**
 * Build instanced-circle data for a graph's nodes. Shares the graph's positions buffer
 * as the instance centres (no copy); radii/colours are constant for now (degree/flow
 * scaling lands with styling).
 */
export function nodeCircles(graph: NetworkGraph, style: NodeStyleResolved): InstancedCirclesData {
  const count = graph.nodeCount;
  const radii = new Float32Array(count).fill(style.radius);

  const c = rgb(style.fill);
  const r = Math.round(c.r) & 255;
  const g = Math.round(c.g) & 255;
  const b = Math.round(c.b) & 255;
  const a = Math.round((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255) & 255;
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = a;
  }

  // Share the graph's positions buffer as instance centres (no copy); the GPU uploads it.
  return { centers: graph.positions, radii, colors, count };
}
