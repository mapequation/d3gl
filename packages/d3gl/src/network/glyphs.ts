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
  /** Optional flow-border ring (#104 N6); `null`/absent ⇒ plain filled nodes. */
  border?: ResolvedFlowBorder | null;
}

export interface LinkStyleResolved {
  width: number;
  stroke: string;
  /** Bend (#104 N6c): quadratic-bezier control offset ⟂ to the chord, as a fraction of chord length (0 = straight). */
  bend?: number;
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
 * Flow-border style (#104 N6): a ring around each node/module whose width encodes a per-node flow
 * (e.g. Infomap enter/exit flow). The app supplies the flow; d3gl renders the ring. For module
 * aggregates the metric is summed over members (see {@link computeLODStyle}).
 */
export interface FlowBorderSpec {
  /**
   * Per-node enter/exit flow driving the border width: a caller `Float32Array` (length `nodeCount`)
   * or a built-in {@link NodeMetric}. Summed over members for module aggregates.
   */
  flow: Float32Array | NodeMetric;
  /** Maps the (summed) flow → ring width in the active `sizeMode`'s units, e.g. `scaleSqrt().range([0, 6])`. */
  scale: (value: number) => number;
  /** Ring colour (any CSS colour). Default: a darker shade of the node fill. */
  color?: string;
}

/** Resolved {@link FlowBorderSpec}: raw per-node metric + draw scale + ring colour (bytes for WebGL, CSS for export). */
export interface ResolvedFlowBorder {
  /** Raw per-node flow metric, length `nodeCount`; sum-aggregated onto the LOD tree for modules. */
  metric: Float32Array;
  scale: (value: number) => number;
  color: [number, number, number, number];
  colorCss: string;
}

/**
 * Resolve a {@link FlowBorderSpec} against a graph. `fallbackColor` (the node fill) defaults the ring
 * colour to a darker shade. Resolved once per `style()` — never per frame.
 */
export function resolveFlowBorder(graph: NetworkGraph, spec: FlowBorderSpec, fallbackColor: string): ResolvedFlowBorder {
  const n = graph.nodeCount;
  let metric: Float32Array;
  if (spec.flow instanceof Float32Array) {
    if (spec.flow.length !== n) throw new Error(`flowBorder.flow length ${spec.flow.length} !== nodeCount ${n}`);
    metric = spec.flow;
  } else {
    const value = metricAccessor(graph, spec.flow);
    metric = new Float32Array(n);
    for (let i = 0; i < n; i++) metric[i] = value(i);
  }
  const colorCss = spec.color ?? rgb(fallbackColor).darker(0.8).formatHex();
  return { metric, scale: spec.scale, color: toRGBA(colorCss), colorCss };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Per-instance border-ring arrays for a batch of circles: thickness as a fraction of the *drawn*
 * radius (`scale(value)/radius`, clamped to `[0,1]`) plus a repeated RGBA ring colour.
 */
function buildBorders(
  count: number,
  radii: ArrayLike<number>,
  valueOf: (i: number) => number,
  scale: (v: number) => number,
  color: [number, number, number, number],
): { borders: Float32Array; borderColors: Uint8Array } {
  const borders = new Float32Array(count);
  const borderColors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = radii[i]!;
    borders[i] = r > 0 ? clamp01(scale(valueOf(i)) / r) : 0;
    borderColors[i * 4] = color[0];
    borderColors[i * 4 + 1] = color[1];
    borderColors[i * 4 + 2] = color[2];
    borderColors[i * 4 + 3] = color[3];
  }
  return { borders, borderColors };
}

/**
 * Inner-disc radii (`radius − ring width`) for rendering a flow border as two stacked discs (a
 * border-colour disc under a smaller fill disc) on the SVG/Canvas export path, which has no
 * per-element ring primitive. `metric` is the raw per-node flow.
 */
export function flowBorderInnerRadii(radii: ArrayLike<number>, metric: ArrayLike<number>, scale: (v: number) => number): Float32Array {
  const n = radii.length;
  const inner = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = radii[i]!;
    inner[i] = Math.max(0, r - Math.min(r, scale(metric[i]!)));
  }
  return inner;
}

/**
 * Instanced-circle data for a graph's nodes. Shares the graph's positions buffer as the
 * instance centres *and* the resolved per-node `radii` buffer (no copies) — `radii` is already a
 * per-instance GPU attribute, so degree/flow-scaled sizing costs nothing extra at draw time. With a
 * resolved {@link ResolvedFlowBorder} it also emits the per-node ring (#104 N6).
 */
export function nodeCircles(graph: NetworkGraph, style: NodeStyleResolved): InstancedCirclesData {
  const count = graph.nodeCount;
  const colors = fillColors(count, style.fill);
  if (style.border) {
    const { metric, scale, color } = style.border;
    const { borders, borderColors } = buildBorders(count, style.radii, (i) => metric[i]!, scale, color);
    return { centers: graph.positions, radii: style.radii, colors, borders, borderColors, count };
  }
  return { centers: graph.positions, radii: style.radii, colors, count };
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
  /**
   * Optional flow-border ring (#104 N6). Each frontier glyph's ring width comes from the tree's
   * sum-aggregated `border` metric (a module reflects its members' total); `metric` is ignored here.
   */
  border?: ResolvedFlowBorder | null;
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
    // A real leaf, or an aggregate covering a single leaf (the spatial quadtree wraps each isolated
    // point in a 1-child cell, #103) — draw it as that point: leaf fill, uncapped radius.
    const isLeafNode = g < tree.leafCount || tree.count[g] === 1;
    radii[i] = isLeafNode ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg);
    const c = isLeafNode ? leaf : agg;
    colors[i * 4] = c[0];
    colors[i * 4 + 1] = c[1];
    colors[i * 4 + 2] = c[2];
    colors[i * 4 + 3] = c[3];
  }
  if (style.border) {
    const { scale, color } = style.border;
    const { borders, borderColors } = buildBorders(count, radii, (i) => tree.border[frontier[i]!]!, scale, color);
    return { centers, radii, colors, borders, borderColors, count };
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

export interface BentSuperEdgeStyleResolved {
  /** Constant link width, unless `flowScale` is given. */
  width: number;
  stroke: string;
  /** Bend (fraction of chord) for the bezier links. */
  bend: number;
  /** Optional map flow → link width (e.g. `scaleSqrt`), so width ∝ √flow; constant `width` when absent. */
  flowScale?: (flow: number) => number;
  /** Draw one-sided half-arrowheads (directed maps). */
  directed: boolean;
  arrowSize: number;
  arrowFill: string;
  /** Aggregate draw-radius cap, so a head sits at the (capped) module boundary, not its centre. */
  maxAggregateRadius?: number;
}

/**
 * Instanced **bent half-arrow super-edges** for the map register (#104 N6c): inter-module links drawn
 * from the tree's directed, flow-weighted {@link LODTree.superEdgeOffset} adjacency. For each visible
 * frontier node, its directed super-edges to *also-visible* nodes are emitted as bezier strips (width
 * ∝ √flow via `flowScale`); on a directed map each gets a one-sided half-arrow set back to the target
 * module's boundary, so reciprocal links bow apart. Returns both layers (lines under arrows).
 */
export function bentSuperEdges(
  tree: LODTree,
  frontier: Uint32Array,
  style: BentSuperEdgeStyleResolved,
): { lines: InstancedLinesData; arrows: InstancedArrowsData } {
  const off = tree.superEdgeOffset;
  const tgt = tree.superEdgeTarget;
  const flw = tree.superEdgeFlow;
  const present = new Uint8Array(tree.size);
  for (let i = 0; i < frontier.length; i++) present[frontier[i]!] = 1;

  const aS: number[] = [];
  const bS: number[] = [];
  const wS: number[] = [];
  if (off && tgt && flw) {
    for (let i = 0; i < frontier.length; i++) {
      const g = frontier[i]!;
      for (let p = off[g]!; p < off[g + 1]!; p++) {
        const h = tgt[p]!;
        if (present[h]) {
          aS.push(g);
          bS.push(h);
          wS.push(flw[p]!);
        }
      }
    }
  }

  const count = aS.length;
  const maxAgg = style.maxAggregateRadius ?? Infinity;
  const drawnRadius = (g: number): number => (g < tree.leafCount ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg));

  const sources = new Float32Array(count * 2);
  const targets = new Float32Array(count * 2);
  const widths = new Float32Array(count);
  const bends = new Float32Array(count).fill(style.bend);
  const aTargets = new Float32Array(count * 2);
  const aSizes = new Float32Array(count).fill(style.arrowSize);
  const aBends = new Float32Array(count).fill(style.bend);
  for (let e = 0; e < count; e++) {
    const g = aS[e]!;
    const h = bS[e]!;
    const sx = tree.cx[g]!;
    const sy = tree.cy[g]!;
    const tx = tree.cx[h]!;
    const ty = tree.cy[h]!;
    sources[e * 2] = sx;
    sources[e * 2 + 1] = sy;
    targets[e * 2] = tx;
    targets[e * 2 + 1] = ty;
    widths[e] = style.flowScale ? style.flowScale(wS[e]!) : style.width;
    // Arrow tip set back to the target module's boundary along the bezier end-tangent.
    const [ux, uy] = bentEndTangent(sx, sy, tx, ty, style.bend);
    const setback = drawnRadius(h);
    aTargets[e * 2] = tx - ux * setback;
    aTargets[e * 2 + 1] = ty - uy * setback;
  }

  const lines: InstancedLinesData = { sources, targets, widths, colors: fillColors(count, style.stroke), bends, samples: BENT_SAMPLES, count };
  const arrows: InstancedArrowsData = style.directed
    ? { sources, targets: aTargets, sizes: aSizes, colors: fillColors(count, style.arrowFill), bends: aBends, half: true, count }
    : { sources: new Float32Array(0), targets: new Float32Array(0), sizes: new Float32Array(0), colors: new Uint8Array(0), count: 0 };
  return { lines, arrows };
}

/** Path-strip samples for a smooth bent link (#104 N6c). */
const BENT_SAMPLES = 24;

/** Quadratic-bezier control point for a bent link: chord midpoint offset ⟂ by `bend`·|chord| — matches the strip shader. */
export function bezierControl(sx: number, sy: number, tx: number, ty: number, bend: number): [number, number] {
  const dx = tx - sx;
  const dy = ty - sy;
  return [(sx + tx) / 2 - dy * bend, (sy + ty) / 2 + dx * bend];
}

/** Unit end-tangent of a bent link at the target — matches the arrow shader's bezier `t=1` tangent. */
export function bentEndTangent(sx: number, sy: number, tx: number, ty: number, bend: number): [number, number] {
  const dx = tx - sx;
  const dy = ty - sy;
  const ex = 0.5 * dx + dy * bend;
  const ey = 0.5 * dy - dx * bend;
  const el = Math.hypot(ex, ey) || 1;
  return [ex / el, ey / el];
}

/**
 * Instanced line data for a graph's links, gathering each edge's endpoints from the node positions
 * by index. Straight by default; with `style.bend` the links bow into quadratic beziers (#104 N6c),
 * drawn as multi-sample strips. Rebuilt when positions change (it copies, unlike {@link nodeCircles}).
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
  const colors = fillColors(count, style.stroke);
  if (style.bend) {
    return { sources, targets, widths, colors, bends: new Float32Array(count).fill(style.bend), samples: BENT_SAMPLES, count };
  }
  return { sources, targets, widths, colors, count };
}

export interface ArrowStyleResolved {
  size: number;
  /** Per-node radii (world units) — the tip is set back by the *target* node's radius. */
  nodeRadii: Float32Array;
  fill: string;
  /** Bend (#104 N6c), matching the link's — the head sits on the bezier end-tangent. */
  bend?: number;
  /** Draw a one-sided **half** arrowhead (#104 N6c). */
  half?: boolean;
}

/**
 * Instanced arrowhead data for a directed graph's links. The tip sits the *target* node's radius
 * back from its centre (so it meets the node boundary even when nodes are degree/flow-sized),
 * oriented along the link's end-tangent — the chord for straight links, the bezier tangent when
 * `style.bend` is set (#104 N6c).
 */
export function linkArrows(graph: NetworkGraph, style: ArrowStyleResolved): InstancedArrowsData {
  const count = graph.edgeCount;
  const bend = style.bend ?? 0;
  const sources = new Float32Array(count * 2);
  const targets = new Float32Array(count * 2);
  for (let e = 0; e < count; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    const sx = graph.positions[s * 2]!;
    const sy = graph.positions[s * 2 + 1]!;
    const tx = graph.positions[t * 2]!;
    const ty = graph.positions[t * 2 + 1]!;
    const [ux, uy] = bend ? bentEndTangent(sx, sy, tx, ty, bend) : straightUnit(sx, sy, tx, ty);
    const setback = style.nodeRadii[t]!;
    sources[e * 2] = sx;
    sources[e * 2 + 1] = sy;
    targets[e * 2] = tx - ux * setback;
    targets[e * 2 + 1] = ty - uy * setback;
  }
  const sizes = new Float32Array(count).fill(style.size);
  const colors = fillColors(count, style.fill);
  if (bend) {
    return { sources, targets, sizes, colors, bends: new Float32Array(count).fill(bend), half: style.half, count };
  }
  return { sources, targets, sizes, colors, count };
}

/** Unit chord direction source→target (1,0 if degenerate). */
function straightUnit(sx: number, sy: number, tx: number, ty: number): [number, number] {
  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
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
  /** Flow-border ring (#104 N6), or `null` when disabled (plain filled nodes). */
  flowBorder: ResolvedFlowBorder | null;
  /**
   * Link bend (#104 N6c): quadratic-bezier control offset ⟂ to the chord, as a fraction of chord
   * length. `0` (default) ⇒ straight links; non-zero bows links into curves, and directed links get
   * a one-sided **half-arrow** so reciprocal A→B / B→A links separate (the map-of-networks style).
   */
  linkBend: number;
}

/**
 * Assemble the ordered instanced layers for a network: links (under), arrowheads (directed
 * only), then nodes (on top). Pure — the engine just pushes the result to the backend, which
 * keeps "what to render" unit-testable without a DOM or GPU.
 */
export function networkLayers(graph: NetworkGraph, style: ResolvedNetworkStyle): InstancedLayer[] {
  const layers: InstancedLayer[] = [];
  const bend = style.linkBend;
  if (graph.edgeCount > 0) {
    layers.push({
      name: "links",
      primitive: "lines",
      lines: linkLines(graph, { width: style.linkWidth, stroke: style.linkStroke, bend }),
      sizeMode: style.sizeMode,
    });
    if (style.directed) {
      layers.push({
        name: "arrows",
        primitive: "arrows",
        // Bent links get a one-sided half-arrow so reciprocal links don't collide (#104 N6c).
        arrows: linkArrows(graph, { size: style.arrowSize, nodeRadii: style.nodeRadii, fill: style.arrowFill, bend, half: bend !== 0 }),
        // Arrowheads remain world-sized until their screen-mode shader lands (#103); harmless in
        // world mode, slightly inconsistent in screen mode for directed graphs.
        sizeMode: "world",
      });
    }
  }
  layers.push({
    name: "nodes",
    primitive: "circles",
    circles: nodeCircles(graph, { radii: style.nodeRadii, fill: style.nodeFill, border: style.flowBorder }),
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

/** Emit each link as a stroked drawable, keyed by edge index. With `bend` it bows into a quadratic bezier (#104 N6c). */
export function emitLinks(g: GroupBuilder, graph: NetworkGraph, width: number, bend = 0): void {
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
        if (bend) {
          const [cxp, cyp] = bezierControl(sx, sy, tx, ty, bend);
          ctx.quadraticCurveTo(cxp, cyp, tx, ty);
        } else {
          ctx.lineTo(tx, ty);
        }
      },
      { lineWidth: width },
    );
  }
}

/**
 * Emit each directed link's arrowhead as a filled triangle, tip set back by the target node's radius
 * and oriented along the link's end-tangent (the bezier tangent when `bend` is set). With `half` the
 * triangle is one-sided (#104 N6c), matching the WebGL half-arrow.
 */
export function emitArrows(g: GroupBuilder, graph: NetworkGraph, size: number, nodeRadii: Float32Array, bend = 0, half = false): void {
  for (let e = 0; e < graph.edgeCount; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    const sx = graph.positions[s * 2]!;
    const sy = graph.positions[s * 2 + 1]!;
    const tx = graph.positions[t * 2]!;
    const ty = graph.positions[t * 2 + 1]!;
    const [ux, uy] = bend ? bentEndTangent(sx, sy, tx, ty, bend) : straightUnit(sx, sy, tx, ty);
    const px = -uy;
    const py = ux;
    const setback = nodeRadii[t]!;
    const tipX = tx - ux * setback;
    const tipY = ty - uy * setback;
    const baseX = tipX - ux * 2 * size;
    const baseY = tipY - uy * 2 * size;
    g.drawable(e, (ctx) => {
      ctx.moveTo(tipX, tipY);
      // Half-arrow: base on one side of the centreline only (tip → centre-base → +side).
      ctx.lineTo(half ? baseX : baseX - px * size, half ? baseY : baseY - py * size);
      ctx.lineTo(baseX + px * size, baseY + py * size);
      ctx.closePath();
    });
  }
}
