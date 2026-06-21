import { rgb } from "d3-color";
import type { InstancedCirclesData, InstancedLinesData, InstancedArrowsData, InstancedLayer, GroupBuilder } from "../core/index.js";
import type { NetworkGraph } from "./graph.js";
import type { LODTree } from "./lod.js";

/**
 * Glyph builders for the network module (#100, epic #98) — the instanced "emitters".
 * Each glyph is defined once here and emitted to the instanced WebGL lane (this file)
 * or, later, to the PathContext seam for SVG/Canvas export (#100 N2.3).
 */

/**
 * A built-in per-node metric d3gl can read directly, or a custom `(index, graph) => value` accessor.
 * `"degree"` is the neighbour count ({@link CSR.degree}); `"strength"` the weighted degree
 * ({@link NetworkGraph.strength}); `"flow"` the app-provided {@link NetworkGraph.flow} (errors if absent).
 */
export type NodeMetric = "degree" | "strength" | "flow" | ((index: number, graph: NetworkGraph) => number);

/**
 * How node radius is determined. Resolves once (per `style()` call) to a per-node `Float32Array`,
 * which is already a per-instance GPU attribute — so any of these forms is free at draw time.
 *
 * - `number` — one constant radius for every node.
 * - `Float32Array` — caller-supplied per-node radii (length must equal `nodeCount`); used as-is.
 * - function — `(value, index, graph) => radius`, where `value` is the node's **degree**. A bare d3
 *   scale fits here directly: `scaleSqrt().domain([1, maxDegree]).range([2, 20])`.
 * - `{ by, scale }` — feed a chosen metric through any scale: `{ by: "strength", scale }`. Use this
 *   to size by `strength`/`flow` (or a custom accessor) with a reusable scale instead of degree.
 */
export type NodeRadiusSpec =
  | number
  | Float32Array
  | ((value: number, index: number, graph: NetworkGraph) => number)
  | { by: NodeMetric; scale: (value: number) => number };

/** Resolve a {@link NodeMetric} to an `(index) => value` reader over the graph's metric arrays. */
function metricAccessor(graph: NetworkGraph, by: NodeMetric): (index: number) => number {
  if (typeof by === "function") return (i) => by(i, graph);
  switch (by) {
    case "degree":
      return (i) => graph.csr.degree[i]!;
    case "strength":
      return (i) => graph.strength[i]!;
    case "flow": {
      const flow = graph.flow;
      if (!flow) throw new Error(`nodeRadius by:"flow" requires nodeFlow passed to buildGraph()`);
      return (i) => flow[i]!;
    }
    default:
      throw new Error(`nodeRadius: unknown metric ${JSON.stringify(by)}`);
  }
}

/**
 * Resolve a {@link NodeRadiusSpec} to a per-node `Float32Array` of radii (length `nodeCount`).
 * Called once per `style()` change — never per frame.
 */
export function resolveNodeRadii(graph: NetworkGraph, spec: NodeRadiusSpec): Float32Array {
  const n = graph.nodeCount;
  if (typeof spec === "number") return new Float32Array(n).fill(spec);
  if (spec instanceof Float32Array) {
    if (spec.length !== n) throw new Error(`nodeRadius Float32Array length ${spec.length} !== nodeCount ${n}`);
    return spec; // used directly as the instance buffer — no copy
  }
  const radii = new Float32Array(n);
  if (typeof spec === "function") {
    const degree = graph.csr.degree;
    for (let i = 0; i < n; i++) radii[i] = spec(degree[i]!, i, graph);
    return radii;
  }
  const value = metricAccessor(graph, spec.by);
  const { scale } = spec;
  for (let i = 0; i < n; i++) radii[i] = scale(value(i));
  return radii;
}

export interface NodeStyleResolved {
  /** Per-node radius (world units), length `graph.nodeCount`. Resolved via {@link resolveNodeRadii}. */
  radii: Float32Array;
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
 * instance centres *and* the resolved per-node `radii` buffer (no copies) — `radii` is already a
 * per-instance GPU attribute, so degree/flow-scaled sizing costs nothing extra at draw time.
 */
export function nodeCircles(graph: NetworkGraph, style: NodeStyleResolved): InstancedCirclesData {
  const count = graph.nodeCount;
  return { centers: graph.positions, radii: style.radii, colors: fillColors(count, style.fill), count };
}

export interface FrontierStyleResolved {
  /** Fill for real leaves (individual nodes). */
  nodeFill: string;
  /** Fill for aggregate glyphs (collapsed subtrees). */
  aggregateFill: string;
  /**
   * Cap (in the layer's size units) on the aggregate draw radius. The tree's area-additive radius
   * (`√Σ child radius²`) grows without bound for large subtrees — harmless in world units but it
   * would balloon as pixels in screen `sizeMode`, so aggregates clamp here. Leaves are never capped.
   * Default unbounded.
   */
  maxAggregateRadius?: number;
}

/**
 * Instanced-circle data for an LOD cut frontier: each frontier node drawn at its tree-resolved
 * {@link LODTree.radius} and centroid, leaves in `nodeFill` and aggregates in `aggregateFill`
 * (capped at `maxAggregateRadius`). The frontier is bounded by the viewport + expand threshold, so
 * this small buffer is cheap to rebuild per pan/zoom frame (the instanced lane reallocates, but only
 * over the visible set, not all of N).
 */
export function frontierCircles(tree: LODTree, frontier: Uint32Array, style: FrontierStyleResolved): InstancedCirclesData {
  const count = frontier.length;
  const maxAgg = style.maxAggregateRadius ?? Infinity;
  const centers = new Float32Array(count * 2);
  const radii = new Float32Array(count);
  const colors = new Uint8Array(count * 4);
  const leaf = toRGBA(style.nodeFill);
  const agg = toRGBA(style.aggregateFill);
  for (let i = 0; i < count; i++) {
    const g = frontier[i]!;
    centers[i * 2] = tree.cx[g]!;
    centers[i * 2 + 1] = tree.cy[g]!;
    const isLeafNode = g < tree.leafCount;
    radii[i] = isLeafNode ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg);
    const c = isLeafNode ? leaf : agg;
    colors[i * 4] = c[0];
    colors[i * 4 + 1] = c[1];
    colors[i * 4 + 2] = c[2];
    colors[i * 4 + 3] = c[3];
  }
  return { centers, radii, colors, count };
}

export interface SuperEdgeStyleResolved {
  width: number;
  stroke: string;
}

/**
 * Instanced line data for **super-edges**: every same-level edge incident to a *visible* frontier
 * node is drawn — a visible node keeps all its edges, so connections don't vanish when a neighbour
 * scrolls off-screen or is decluttered away (the edge is drawn toward the neighbour's position).
 * When both endpoints are visible the edge is deduped (`g < h`); when only one is visible it is drawn
 * once from the visible side. Leaf neighbours come from the graph CSR (a leaf's global id is its node
 * id); aggregate neighbours from the tree's coarse adjacency. Cross-level pairs (a node linked to a
 * region shown at a different LOD level) are approximated to the neighbour's centroid for now.
 */
export function superEdgeLines(
  graph: NetworkGraph,
  tree: LODTree,
  frontier: Uint32Array,
  style: SuperEdgeStyleResolved,
): InstancedLinesData {
  const present = new Uint8Array(tree.size);
  for (let i = 0; i < frontier.length; i++) present[frontier[i]!] = 1;

  const a: number[] = [];
  const b: number[] = [];
  const { offsets, neighbors } = graph.csr;
  for (let i = 0; i < frontier.length; i++) {
    const g = frontier[i]!;
    const leaf = g < tree.leafCount;
    const from = leaf ? offsets[g]! : tree.edgeOffset[g]!;
    const to = leaf ? offsets[g + 1]! : tree.edgeOffset[g + 1]!;
    for (let p = from; p < to; p++) {
      const h = leaf ? neighbors[p]! : tree.edgeNeighbors[p]!;
      // Both visible → emit once (from the smaller id). Neighbour hidden → emit from the visible g.
      if (present[h] ? g < h : true) {
        a.push(g);
        b.push(h);
      }
    }
  }

  const count = a.length;
  const sources = new Float32Array(count * 2);
  const targets = new Float32Array(count * 2);
  for (let e = 0; e < count; e++) {
    const g = a[e]!;
    const h = b[e]!;
    sources[e * 2] = tree.cx[g]!;
    sources[e * 2 + 1] = tree.cy[g]!;
    targets[e * 2] = tree.cx[h]!;
    targets[e * 2 + 1] = tree.cy[h]!;
  }
  const widths = new Float32Array(count).fill(style.width);
  return { sources, targets, widths, colors: fillColors(count, style.stroke), count };
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
  /** Per-node radii (world units) — the tip is set back by the *target* node's radius. */
  nodeRadii: Float32Array;
  fill: string;
}

/**
 * Instanced arrowhead data for a directed graph's links. The tip sits the *target* node's radius
 * back from its centre (so it meets the node boundary even when nodes are degree/flow-sized),
 * oriented from the source.
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
    const setback = style.nodeRadii[t]!;
    sources[e * 2] = sx;
    sources[e * 2 + 1] = sy;
    targets[e * 2] = tx - ux * setback;
    targets[e * 2 + 1] = ty - uy * setback;
  }
  const sizes = new Float32Array(count).fill(style.size);
  return { sources, targets, sizes, colors: fillColors(count, style.fill), count };
}

/** Fully-resolved network style (defaults applied) for assembling the render layers. */
export interface ResolvedNetworkStyle {
  /** Per-node radii, length `nodeCount`; resolved via {@link resolveNodeRadii}. Units follow `sizeMode`. */
  nodeRadii: Float32Array;
  nodeFill: string;
  linkWidth: number;
  linkStroke: string;
  arrowSize: number;
  arrowFill: string;
  directed: boolean;
  /**
   * `"world"` (default) sizes glyphs in world units (they scale with zoom); `"screen"` sizes them in
   * constant pixels (the navigation register for large layouts — glyphs don't vanish when zoomed
   * out). Arrowheads are world-only for now (their screen-mode shader is a tracked gap, #103).
   */
  sizeMode: "world" | "screen";
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
      sizeMode: style.sizeMode,
    });
    if (style.directed) {
      layers.push({
        name: "arrows",
        primitive: "arrows",
        arrows: linkArrows(graph, { size: style.arrowSize, nodeRadii: style.nodeRadii, fill: style.arrowFill }),
        // Arrowheads remain world-sized until their screen-mode shader lands (#103); harmless in
        // world mode, slightly inconsistent in screen mode for directed graphs.
        sizeMode: "world",
      });
    }
  }
  layers.push({
    name: "nodes",
    primitive: "circles",
    circles: nodeCircles(graph, { radii: style.nodeRadii, fill: style.nodeFill }),
    sizeMode: style.sizeMode,
  });
  return layers;
}

// ---------------------------------------------------------------------------
// PathContext emitters — the second emitter of each glyph (#100 N2.3). They draw
// the same glyphs into a Scene GroupBuilder so SVG/Canvas backends render small
// networks and toSVG() produces publication output, reusing the existing pipeline.
// ---------------------------------------------------------------------------

/** Emit each node as a circle (point) drawable, keyed by node index, sized by its resolved radius. */
export function emitNodes(g: GroupBuilder, graph: NetworkGraph, radii: Float32Array): void {
  for (let i = 0; i < graph.nodeCount; i++) {
    g.point(i, graph.positions[i * 2]!, graph.positions[i * 2 + 1]!, radii[i]!);
  }
}

/** Emit each link as a stroked line drawable, keyed by edge index. */
export function emitLinks(g: GroupBuilder, graph: NetworkGraph, width: number): void {
  for (let e = 0; e < graph.edgeCount; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    const sx = graph.positions[s * 2]!;
    const sy = graph.positions[s * 2 + 1]!;
    const tx = graph.positions[t * 2]!;
    const ty = graph.positions[t * 2 + 1]!;
    g.drawable(
      e,
      (ctx) => {
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
      },
      { lineWidth: width },
    );
  }
}

/** Emit each directed link's arrowhead as a filled triangle, tip set back by the target node's radius. */
export function emitArrows(g: GroupBuilder, graph: NetworkGraph, size: number, nodeRadii: Float32Array): void {
  for (let e = 0; e < graph.edgeCount; e++) {
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
    const px = -uy;
    const py = ux;
    const setback = nodeRadii[t]!;
    const tipX = tx - ux * setback;
    const tipY = ty - uy * setback;
    const baseX = tipX - ux * 2 * size;
    const baseY = tipY - uy * 2 * size;
    g.drawable(e, (ctx) => {
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(baseX - px * size, baseY - py * size);
      ctx.lineTo(baseX + px * size, baseY + py * size);
      ctx.closePath();
    });
  }
}
