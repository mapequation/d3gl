import { rgb } from "d3-color";
import type { InstancedCirclesData, InstancedPieData, InstancedLinesData, InstancedArrowsData, InstancedHalfArrowsData, InstancedLayer, GroupBuilder } from "../core/index.js";
import type { NetworkGraph } from "./graph.js";
import type { PhysicalPieWedges } from "./pie.js";
import type { LODTree, LODTransform } from "./lod.js";
import type { ScreenRect } from "../core/instanced-lane.js";
import { halfLinkGeometry, traceHalfLink, scaleHalfLink } from "./half-link.js";

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

/**
 * When {@link NodeRadiusSpec} sizes by an **additive metric** (`{ by, scale }` — degree/strength/flow,
 * or a custom accessor), expose the per-leaf metric value + the scale so LOD aggregates size by the
 * SAME scale applied to their summed child value (a module's radius from its members' total flow),
 * rather than the area-additive `√Σr²` fallback. Returns `null` for constant / `Float32Array` /
 * degree-function specs — there is no additive value to sum, so aggregates keep the fallback.
 */
export function resolveNodeRadiusAggregate(
  graph: NetworkGraph,
  spec: NodeRadiusSpec,
): { leafValue: Float32Array; radiusOf: (value: number) => number } | null {
  if (typeof spec === "number" || typeof spec === "function" || spec instanceof Float32Array) return null;
  const accessor = metricAccessor(graph, spec.by);
  const n = graph.nodeCount;
  const leafValue = new Float32Array(n);
  for (let i = 0; i < n; i++) leafValue[i] = accessor(i);
  return { leafValue, radiusOf: spec.scale };
}

/**
 * How a node's **declutter importance** is determined: a {@link NodeMetric} (`"degree"`/`"strength"`/
 * `"flow"`/accessor), a per-node `Float32Array`, or `"order"` (a flat priority — so the survivor of a
 * cluster falls back to input order, and an aggregate ranks by its subtree size). Resolved per-leaf and
 * summed up the LOD tree (so a module's importance is its members' total — e.g. total flow), then used
 * to break overlaps in the declutter: the highest-importance glyph in a cluster is kept.
 */
export type ImportanceSpec = NodeMetric | Float32Array | "order";

/**
 * Resolve an {@link ImportanceSpec} to per-leaf importance values (length `nodeCount`). When unset it
 * **defaults to the node-size metric** — the `{ by }` of a `nodeRadius: { by, scale }` spec — so the
 * biggest glyph wins an overlap (consistent with sizing); for a constant / array / degree-function size
 * it falls back to flat input `"order"`. Called once per `style()` change, never per frame.
 */
export function resolveImportance(graph: NetworkGraph, spec: ImportanceSpec | undefined, nodeRadius: NodeRadiusSpec): Float32Array {
  const n = graph.nodeCount;
  const effective: ImportanceSpec =
    spec ?? (typeof nodeRadius === "object" && !(nodeRadius instanceof Float32Array) ? nodeRadius.by : "order");
  if (effective instanceof Float32Array) {
    if (effective.length !== n) throw new Error(`importance Float32Array length ${effective.length} !== nodeCount ${n}`);
    return effective;
  }
  if (effective === "order") return new Float32Array(n).fill(1); // flat ⇒ aggregates rank by subtree size, leaves by id order
  const value = metricAccessor(graph, effective);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = value(i);
  return out;
}

/** A constant ring of a fixed pixel width (#104 rework) — e.g. a 1px white outline on every node. */
export interface ConstBorder {
  width: number;
  color: [number, number, number, number];
}

export interface NodeStyleResolved {
  /** Per-node radius (world units), length `graph.nodeCount`. Resolved via {@link resolveNodeRadii}. */
  radii: Float32Array;
  fill: string;
  /** Optional per-node RGBA fill (length `4·count`) — overrides `fill` (categorical module colours, #104 rework). */
  colors?: Uint8Array;
  /** Optional flow-border ring (#104 N6); `null`/absent ⇒ plain filled nodes. */
  border?: ResolvedFlowBorder | null;
  /** Optional constant border ring (#104 rework): a fixed px width + colour, independent of flow. */
  constBorder?: ConstBorder | null;
}

/**
 * Link width. A constant, a `(weight) => width` scale of the edge weight (a bare d3 scale fits — its
 * input is the edge's weight, which **is** the per-edge flow), or `{ by, scale }` for parity with
 * {@link NodeRadiusSpec} (`by` is `"weight"`/`"flow"` — the same per-edge quantity — so the scale maps
 * the weight). Whichever form, it resolves to a function of a *weight value*, so a **super-edge**
 * applies the same scale to the **accumulated** weight of the edges it subsumes.
 */
export type LinkWidthSpec = number | ((weight: number) => number) | { by: "weight" | "flow"; scale: (value: number) => number };

/**
 * Link colour. A single CSS colour; a `(weight) => cssColour` scale (a bare d3 sequential/linear colour
 * scale fits — `scaleSqrt().range([light, dark])` interpolates RGBA, alpha included); or `{ by, scale }`
 * for parity with {@link LinkWidthSpec}. Whichever form, it resolves to a function of a *weight value*,
 * so a super-edge colours by its accumulated subsumed weight (darker/heavier reads as more important).
 */
export type LinkColorSpec = string | ((weight: number) => string) | { by: "weight" | "flow"; scale: (value: number) => string };

/** How directed links are drawn: plain `"line"` + a separate arrowhead, or a fused `"half-arrow"` (the map glyph). */
export type LinkStyle = "line" | "half-arrow";

export interface LinkStyleResolved {
  /** Per-edge width from its weight; for super-edges, applied to the accumulated subsumed weight. */
  widthOf: (weight: number) => number;
  /** Per-edge RGBA from its weight; for super-edges, applied to the accumulated subsumed weight. */
  colorOf: (weight: number) => [number, number, number, number];
  /** Bend (#104 N6c): quadratic-bezier control offset ⟂ to the chord, as a fraction of chord length (0 = straight). */
  bend?: number;
}

/** Resolve a {@link LinkWidthSpec} to a `(weight) => width` function (composes with super-edge accumulation). */
export function resolveLinkWidthOf(spec: LinkWidthSpec): (weight: number) => number {
  if (typeof spec === "number") return () => spec;
  if (typeof spec === "function") return spec;
  return spec.scale; // { by, scale }: `by` is the per-edge weight (== flow); `scale` maps it
}

/** Resolve a {@link LinkColorSpec} to a `(weight) => cssColour` function (composes with super-edge accumulation). */
export function resolveLinkStrokeOf(spec: LinkColorSpec): (weight: number) => string {
  if (typeof spec === "string") return () => spec;
  if (typeof spec === "function") return spec;
  return spec.scale; // { by, scale }: `by` is the per-edge weight (== flow); `scale` maps it to a colour
}

/** Resolve a {@link LinkColorSpec} to a `(weight) => RGBA` function (the WebGL twin of {@link resolveLinkStrokeOf}). */
export function resolveLinkColorOf(spec: LinkColorSpec): (weight: number) => [number, number, number, number] {
  const cssOf = resolveLinkStrokeOf(spec);
  return (w) => toRGBA(cssOf(w));
}

/** Per-instance RGBA buffer for a batch of links, colouring each by its weight via `colorOf`. */
function linkColorBytes(weights: ArrayLike<number>, count: number, colorOf: (weight: number) => [number, number, number, number]): Uint8Array {
  const colors = new Uint8Array(count * 4);
  for (let e = 0; e < count; e++) {
    const [r, g, b, a] = colorOf(weights[e]!);
    colors[e * 4] = r;
    colors[e * 4 + 1] = g;
    colors[e * 4 + 2] = b;
    colors[e * 4 + 3] = a;
  }
  return colors;
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
  /**
   * Ring colour: a single CSS colour, or a per-node `(value, index, graph) => cssColour` accessor so
   * the ring colour can also encode the per-node metric (a bare d3 colour scale fits — `value` is the
   * node's flow metric). **Omitted (default): a darker shade of each glyph's own fill** — so a module
   * aggregate's ring is a darker shade of *its* module colour, not one shared colour.
   */
  color?: string | ((value: number, index: number, graph: NetworkGraph) => string);
}

/** Resolved {@link FlowBorderSpec}: raw per-node metric + draw scale + ring colour (bytes for WebGL, CSS for export). */
export interface ResolvedFlowBorder {
  /** Raw per-node flow metric, length `nodeCount`; sum-aggregated onto the LOD tree for modules. */
  metric: Float32Array;
  scale: (value: number) => number;
  /** Representative ring colour (the single colour, or a fallback for LOD aggregates). */
  color: [number, number, number, number];
  colorCss: string;
  /** Per-node ring RGBA (length `4·nodeCount`) when {@link FlowBorderSpec.color} is an accessor; else absent. */
  colors?: Uint8Array;
  /** When set (no explicit colour given), derive each glyph's ring by multiplying its own fill RGB by this factor (0–1). */
  darken?: number;
}

/**
 * Resolve a {@link FlowBorderSpec} against a graph. `fallbackColor` (the node fill) defaults the ring
 * colour to a darker shade; a per-node colour accessor resolves to a `colors` byte buffer. Resolved
 * once per `style()` — never per frame.
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
  if (typeof spec.color === "function") {
    const colorOf = spec.color;
    const colors = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const [r, g, b, a] = toRGBA(colorOf(metric[i]!, i, graph));
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }
    // Representative (the highest-flow node's colour) for LOD aggregates / single-colour fallbacks.
    let rep = 0;
    for (let i = 1; i < n; i++) if (metric[i]! > metric[rep]!) rep = i;
    const colorCss = colorOf(metric[rep] ?? 0, rep, graph);
    return { metric, scale: spec.scale, color: toRGBA(colorCss), colorCss, colors };
  }
  if (spec.color === undefined) {
    // No explicit colour → each glyph's ring is a darker shade of its OWN fill (per-module under LOD).
    // The renderers derive it from the glyph colours via `darken`; colorCss is a representative fallback.
    return { metric, scale: spec.scale, color: toRGBA(rgb(fallbackColor).darker(0.9).formatHex()), colorCss: rgb(fallbackColor).darker(0.9).formatHex(), darken: 0.62 };
  }
  const colorCss = spec.color;
  return { metric, scale: spec.scale, color: toRGBA(colorCss), colorCss };
}

/** Per-instance ring colours = the glyph fill colours darkened (RGB × factor); alpha preserved. */
function darkenColors(fill: ArrayLike<number>, count: number, factor: number): Uint8Array {
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    out[i * 4] = Math.round(fill[i * 4]! * factor);
    out[i * 4 + 1] = Math.round(fill[i * 4 + 1]! * factor);
    out[i * 4 + 2] = Math.round(fill[i * 4 + 2]! * factor);
    out[i * 4 + 3] = fill[i * 4 + 3]!;
  }
  return out;
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
  perNodeColors?: Uint8Array,
): { borders: Float32Array; borderColors: Uint8Array } {
  const borders = new Float32Array(count);
  const borderColors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = radii[i]!;
    borders[i] = r > 0 ? clamp01(scale(valueOf(i)) / r) : 0;
    if (perNodeColors) {
      borderColors[i * 4] = perNodeColors[i * 4]!;
      borderColors[i * 4 + 1] = perNodeColors[i * 4 + 1]!;
      borderColors[i * 4 + 2] = perNodeColors[i * 4 + 2]!;
      borderColors[i * 4 + 3] = perNodeColors[i * 4 + 3]!;
    } else {
      borderColors[i * 4] = color[0];
      borderColors[i * 4 + 1] = color[1];
      borderColors[i * 4 + 2] = color[2];
      borderColors[i * 4 + 3] = color[3];
    }
  }
  return { borders, borderColors };
}

/** Per-instance ring arrays for a constant px-width border (fraction = width/radius), one colour. */
function constBorderArrays(
  count: number,
  radii: ArrayLike<number>,
  width: number,
  color: [number, number, number, number],
): { borders: Float32Array; borderColors: Uint8Array } {
  return buildBorders(count, radii, () => width, (w) => w, color);
}

/** Resolve a per-node fill-colour accessor to a packed RGBA buffer (length `4·nodeCount`), #104 rework. */
export function resolveNodeColors(graph: NetworkGraph, color: (index: number, graph: NetworkGraph) => string): Uint8Array {
  const n = graph.nodeCount;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = toRGBA(color(i, graph));
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
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
  const colors = style.colors ?? fillColors(count, style.fill);
  const base = { centers: graph.positions, radii: style.radii, colors, count };
  if (style.border) {
    const { metric, scale, color, colors: explicit, darken } = style.border;
    // `darken` (no explicit ring colour) ⇒ each node's ring = its own fill darkened.
    const borderNodeColors = darken !== undefined ? darkenColors(colors, count, darken) : explicit;
    return { ...base, ...buildBorders(count, style.radii, (i) => metric[i]!, scale, color, borderNodeColors) };
  }
  if (style.constBorder) {
    return { ...base, ...constBorderArrays(count, style.radii, style.constBorder.width, style.constBorder.color) };
  }
  return base;
}

/**
 * Hit-test a screen point (CSS px) against the full node set (the no-LOD draw) and return the node
 * index under it, or `-1` for a miss. Counterpart to {@link pickFrontier} for graphs drawn without
 * LOD: same projection as the renderer (`screen = world·k + t`; on-screen radius =
 * `screenSized ? radius : radius·k`), last match wins (topmost in paint order). O(node count) — the
 * no-LOD path is the small-graph case, so a linear scan is fine; large graphs use the LOD frontier.
 */
export function pickNodes(
  positions: Float32Array,
  radii: Float32Array | readonly number[],
  count: number,
  x: number,
  y: number,
  t: LODTransform,
  screenSized: boolean,
): number {
  let found = -1;
  for (let i = 0; i < count; i++) {
    const r = radii[i]!;
    const pr = screenSized ? r : r * t.k;
    const dx = x - (positions[2 * i]! * t.k + t.x);
    const dy = y - (positions[2 * i + 1]! * t.k + t.y);
    if (dx * dx + dy * dy <= pr * pr) found = i;
  }
  return found;
}

/**
 * Marquee region query for the no-LOD full graph (#159): the node indices whose **centre** projects
 * inside `rect` (CSS px). Centre-in-rect is sizeMode-independent (only the radius differs by sizeMode,
 * not the centre), so unlike {@link pickNodes} this needs no radius. O(node count), like pickNodes.
 */
export function regionNodes(positions: Float32Array, count: number, rect: ScreenRect, t: LODTransform): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const sx = positions[2 * i]! * t.k + t.x;
    const sy = positions[2 * i + 1]! * t.k + t.y;
    if (sx >= rect.x0 && sx <= rect.x1 && sy >= rect.y0 && sy <= rect.y1) out.push(i);
  }
  return out;
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
  /** Optional constant border ring (#104 rework): fixed px width + colour on every frontier glyph. */
  constBorder?: ConstBorder | null;
  /** Colour each frontier glyph by the tree's per-node `color` (categorical module colours) instead of `nodeFill`/`aggregateFill`. */
  useTreeColor?: boolean;
  /**
   * Cross-fade alpha (#133), indexed by tree-node id (from {@link cut} with a fade band). When set, each
   * glyph's colour alpha is scaled by `fadeAlpha[g]`, so an aggregate eases out as its children ease in
   * across the expand threshold. Absent ⇒ glyphs draw at full opacity.
   */
  fadeAlpha?: Float32Array;
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
  const useTreeColor = style.useTreeColor === true;
  for (let i = 0; i < count; i++) {
    const g = frontier[i]!;
    centers[i * 2] = tree.cx[g]!;
    centers[i * 2 + 1] = tree.cy[g]!;
    // A real leaf, or an aggregate covering a single leaf (the spatial quadtree wraps each isolated
    // point in a 1-child cell, #103) — draw it as that point: leaf fill, uncapped radius.
    const isLeafNode = g < tree.leafCount || tree.count[g] === 1;
    radii[i] = isLeafNode ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg);
    if (useTreeColor) {
      // Categorical module colour, propagated to aggregates by computeLODStyle.
      colors[i * 4] = tree.color[g * 4]!;
      colors[i * 4 + 1] = tree.color[g * 4 + 1]!;
      colors[i * 4 + 2] = tree.color[g * 4 + 2]!;
      colors[i * 4 + 3] = tree.color[g * 4 + 3]!;
    } else {
      const c = isLeafNode ? leaf : agg;
      colors[i * 4] = c[0];
      colors[i * 4 + 1] = c[1];
      colors[i * 4 + 2] = c[2];
      colors[i * 4 + 3] = c[3];
    }
  }
  let result: InstancedCirclesData = { centers, radii, colors, count };
  if (style.border) {
    const { scale, color, colors: explicit, darken } = style.border;
    // `darken` (no explicit ring colour) ⇒ each glyph's ring = its own (module) colour darkened — so a
    // collapsed module's ring is a darker shade of that module's hue, not one shared colour.
    const borderColors = darken !== undefined ? darkenColors(colors, count, darken) : explicit;
    result = { ...result, ...buildBorders(count, radii, (i) => tree.border[frontier[i]!]!, scale, color, borderColors) };
  } else if (style.constBorder) {
    result = { ...result, ...constBorderArrays(count, radii, style.constBorder.width, style.constBorder.color) };
  }
  // Cross-fade (#133): scale fill (and ring) alpha by the per-node fade alpha, so a transitioning
  // aggregate/child eases across the expand threshold.
  if (style.fadeAlpha) {
    scaleAlpha(result.colors, count, frontier, style.fadeAlpha);
    scaleAlpha(result.borderColors, count, frontier, style.fadeAlpha);
  }
  return result;
}

/** Scale each RGBA quad's alpha byte by the per-node cross-fade alpha `fadeAlpha[ids[i]]` (#133). No-op when `colors` is absent. */
function scaleAlpha(colors: Uint8Array | undefined, count: number, ids: ArrayLike<number>, fadeAlpha: Float32Array): void {
  if (!colors) return;
  for (let i = 0; i < count; i++) colors[i * 4 + 3] = Math.round(colors[i * 4 + 3]! * (fadeAlpha[ids[i]!] ?? 1));
}

/** Resolved aggregate-outline style: a `width`-px ring `gap` px outside aggregate glyphs, in `color`. */
export interface AggregateOutlineResolved {
  width: number;
  gap: number;
  color: string;
  maxAggregateRadius?: number;
  /** Cross-fade alpha (#133), indexed by tree-node id — scales each ring's alpha so a halo fades with its aggregate. */
  fadeAlpha?: Float32Array;
}

/**
 * Concentric **outline rings** around the LOD frontier's **aggregate** glyphs only (collapsed modules
 * / subtrees, not leaves), set a `gap` px *outside* each glyph so a thin ring floats around it — a
 * "this is a collapsed module, zoom to expand" cue that leaf nodes don't get. Built as a ring (a circle
 * with transparent fill + a `width`-px border) so the gap shows through; drawn as its own
 * instanced-circles layer *under* the nodes. WebGL/LOD-only (the vector full-graph draw has no aggregates).
 */
export function frontierHalos(tree: LODTree, frontier: Uint32Array, style: AggregateOutlineResolved): FrontierHalosData {
  const maxAgg = style.maxAggregateRadius ?? Infinity;
  const idx: number[] = [];
  for (let i = 0; i < frontier.length; i++) {
    const g = frontier[i]!;
    if (!(g < tree.leafCount || tree.count[g] === 1)) idx.push(i); // aggregates only (not leaves / 1-child cells)
  }
  const count = idx.length;
  const centers = new Float32Array(count * 2);
  const radii = new Float32Array(count);
  const borders = new Float32Array(count);
  const ring = toRGBA(style.color);
  const borderColors = new Uint8Array(count * 4);
  // Stable tree-node id per halo, so the Scene path (#138) keys its ring drawables identically to the
  // frontier glyph they sit behind (and the retained-scene diff stays stable across re-cuts).
  const ids = new Uint32Array(count);
  for (let k = 0; k < count; k++) {
    const g = frontier[idx[k]!]!;
    ids[k] = g;
    centers[k * 2] = tree.cx[g]!;
    centers[k * 2 + 1] = tree.cy[g]!;
    // Outer radius = glyph radius + gap + ring width; the ring occupies the outer `width` px, the gap
    // and the glyph's own area are transparent (a circle with no fill, only a border).
    const outer = Math.min(tree.radius[g]!, maxAgg) + style.gap + style.width;
    radii[k] = outer;
    borders[k] = outer > 0 ? style.width / outer : 0;
    borderColors[k * 4] = ring[0];
    borderColors[k * 4 + 1] = ring[1];
    borderColors[k * 4 + 2] = ring[2];
    borderColors[k * 4 + 3] = ring[3];
  }
  // Cross-fade (#133): a halo fades with its aggregate (ring alpha scaled by the per-node fade alpha).
  if (style.fadeAlpha) scaleAlpha(borderColors, count, ids, style.fadeAlpha);
  // Transparent fill (alpha 0) so only the border ring shows, leaving a gap to the glyph inside it.
  return { centers, radii, colors: new Uint8Array(count * 4), borders, borderColors, count, ids };
}

/** {@link frontierHalos} output: an {@link InstancedCirclesData} ring batch plus the per-halo tree-node `ids` (the Scene path keys rings by them; the WebGL lane ignores them). The ring `borders`/`borderColors` are always present (a halo *is* a ring). */
export interface FrontierHalosData extends InstancedCirclesData {
  ids: Uint32Array;
  borders: Float32Array;
  borderColors: Uint8Array;
}

/** Resolved style for LOD super-edges — the same channels as raw links, applied to accumulated flow. */
export interface SuperEdgeStyleResolved {
  /** `"line"` (bent/straight + optional arrowhead) or `"half-arrow"` (fused, directed). */
  linkStyle: LinkStyle;
  directed: boolean;
  /** Width from a super-edge's accumulated subsumed flow (the same scale as raw links). */
  widthOf: (weight: number) => number;
  /** Colour from the accumulated flow (the same scale as raw links). */
  colorOf: (weight: number) => [number, number, number, number];
  /** Bend: a fraction of chord for `"line"`, an absolute (world/px) offset for `"half-arrow"` — as for raw links. */
  bend: number;
  /** Arrowhead size for the directed `"line"` style. */
  arrowSize: number;
  /** Aggregate draw-radius cap, so a tip/setback sits at the (capped) module boundary, not its centre. */
  maxAggregateRadius?: number;
  /**
   * Also draw **mixed-level** super-edges (#139): an off-frontier on-screen neighbour is projected to its
   * nearest present ancestor (`coverOf`) and the edge drawn there, deduped. Off by default and **zero
   * added cost when off** — the projection pass runs only when this is `true`. Needs `tree.parent`.
   */
  crossLevelEdges?: boolean;
  /**
   * Cross-fade alpha (#133), indexed by tree-node id. When set, each super-edge's alpha is scaled by the
   * least-visible of its two *present* endpoints (off-screen endpoints count as opaque), so an edge fades
   * with the aggregate/child it connects. Absent ⇒ edges draw at full opacity.
   */
  fadeAlpha?: Float32Array;
}

/**
 * Instanced LOD **super-edges**, unified across tree types and link styles (#104 N6). Links are
 * gathered from the tree's directed, flow-weighted super-edge CSR — built identically for a coarsening
 * tree and a module tree (so the edge-LOD logic is one path, not two). A visible node keeps an edge to
 * a neighbour that is **also on the frontier** *or* whose centroid is **off-screen** (drawn toward it,
 * exiting the view) — so a node's edges don't pop out as a neighbour scrolls off, without dangling into
 * an on-screen region that has no glyph (an off-frontier-but-on-screen neighbour — a collapsed↔expanded
 * mismatch — is skipped, deferred to the LOD cross-fade #133). Width + colour come from the accumulated
 * subsumed flow. Rendered as fused **half-arrows** or bent/straight **lines** + (directed) arrowheads —
 * the same glyph choice the non-LOD path makes. `{}` when the tree has no super-edge CSR (spatial tree).
 */
export function superEdges(
  tree: LODTree,
  frontier: Uint32Array,
  style: SuperEdgeStyleResolved,
  view: { minX: number; maxX: number; minY: number; maxY: number },
): SuperEdgesData {
  const off = tree.superEdgeOffset;
  const tgt = tree.superEdgeTarget;
  const flw = tree.superEdgeFlow;
  if (!off || !tgt || !flw) return { ids: [] };

  const present = new Uint8Array(tree.size);
  for (let i = 0; i < frontier.length; i++) present[frontier[i]!] = 1;
  // A neighbour is drawable if it's on the frontier, or its centroid is off-screen (the edge just exits
  // the view toward a real node) — an O(1) test, no cull margin needed. Off-frontier *on-screen*
  // neighbours (collapsed↔expanded) are skipped.
  const offScreen = (h: number): boolean => tree.cx[h]! < view.minX || tree.cx[h]! > view.maxX || tree.cy[h]! < view.minY || tree.cy[h]! > view.maxY;

  // Gather drawable directed super-edges + a reciprocal-flow lookup (for both-on-frontier pairs).
  const aS: number[] = [];
  const bS: number[] = [];
  const wS: number[] = [];
  const flowByPair = new Map<number, number>();
  for (let i = 0; i < frontier.length; i++) {
    const g = frontier[i]!;
    for (let p = off[g]!; p < off[g + 1]!; p++) {
      const h = tgt[p]!;
      if (present[h] || offScreen(h)) {
        aS.push(g);
        bS.push(h);
        wS.push(flw[p]!);
        if (present[h]) flowByPair.set(g * tree.size + h, flw[p]!);
      }
    }
  }
  // Incoming edges to a present node from an **off-screen source** (the transpose) — so a node keeps its
  // in-edges too, not just out-edges, as a neighbour scrolls off (symmetric with the out-walk above).
  // present sources were already emitted from their out-walk, so only off-screen (non-present) ones here.
  const inOff = tree.superEdgeInOffset;
  const inSrc = tree.superEdgeInSource;
  const inFlw = tree.superEdgeInFlow;
  if (inOff && inSrc && inFlw) {
    for (let i = 0; i < frontier.length; i++) {
      const g = frontier[i]!;
      for (let p = inOff[g]!; p < inOff[g + 1]!; p++) {
        const s = inSrc[p]!;
        if (!present[s] && offScreen(s)) {
          aS.push(s);
          bS.push(g);
          wS.push(inFlw[p]!);
        }
      }
    }
  }
  // Mixed-level super-edges (#139): the same-level walk skips an off-frontier *on-screen* neighbour (the
  // collapsed↔expanded mismatch). Project it to its nearest present ancestor (`coverOf`) and draw the
  // edge there, deduping per directed pair to sum flow. Iterating from each present node covers both
  // directions: the finer present side projects the coarser neighbour *up* to a present ancestor; the
  // coarse side's walk into a finer-expanded region can't project up (its present nodes are below it) and
  // is simply redundant — so there's no double counting. Gated on `crossLevelEdges` (+ the parent map),
  // so it's ZERO added cost when off (the same-level gather above is untouched).
  const par = tree.parent;
  if (style.crossLevelEdges && par) {
    // Nearest present ancestor of `h` (climb parents), or -1 if none — memoised with path-compression so
    // the whole pass stays O(off-frontier-on-screen incidences · depth). Keyed in a Map over only the
    // **touched** nodes: a per-frame `Int32Array(tree.size).fill(-2)` would be an O(all tree nodes)
    // allocation + write every frame, defeating LOD's O(visible) intent (#144 perf section).
    const cover = new Map<number, number>(); // node id → nearest present ancestor (-1 = none)
    const coverOf = (h: number): number => {
      let x = h;
      while (x >= 0 && !cover.has(x) && !present[x]) x = par[x]!;
      const c = x < 0 ? -1 : present[x] ? x : cover.get(x)!;
      for (let y = h; y >= 0 && y !== x; y = par[y]!) cover.set(y, c); // backfill the climbed chain
      return c;
    };
    const proj = new Map<number, number>(); // directed pair key (a·size + b) → summed flow
    // Out: a present node's out-edge to an off-frontier on-screen target → project the target up (g → c).
    for (let i = 0; i < frontier.length; i++) {
      const g = frontier[i]!;
      for (let p = off[g]!; p < off[g + 1]!; p++) {
        const h = tgt[p]!;
        if (present[h] || offScreen(h)) continue; // already emitted by the same-level walk
        const c = coverOf(h);
        if (c >= 0 && c !== g) {
          const key = g * tree.size + c;
          proj.set(key, (proj.get(key) ?? 0) + flw[p]!);
        }
      }
    }
    // In: a present node's in-edge from an off-frontier on-screen source → project the source up (c → g).
    if (inOff && inSrc && inFlw) {
      for (let i = 0; i < frontier.length; i++) {
        const g = frontier[i]!;
        for (let p = inOff[g]!; p < inOff[g + 1]!; p++) {
          const s = inSrc[p]!;
          if (present[s] || offScreen(s)) continue; // present: from its out-walk; off-screen: handled above
          const c = coverOf(s);
          if (c >= 0 && c !== g) {
            const key = c * tree.size + g;
            proj.set(key, (proj.get(key) ?? 0) + inFlw[p]!);
          }
        }
      }
    }
    for (const [key, w] of proj) {
      const a = Math.floor(key / tree.size);
      const b = key - a * tree.size;
      aS.push(a);
      bS.push(b);
      wS.push(w);
      flowByPair.set(key, w); // both endpoints present → feed reciprocal half-arrow widths too
    }
  }
  const count = aS.length;
  // Stable per-super-edge id (the directed tree-node pair), parallel to `count`. The Scene path (#138)
  // keys its link drawables by it so the retained-scene diff is stable across re-cuts; the WebGL lane
  // ignores it. Half-arrows and lines/arrows share the one edge order, so one id array serves both.
  const ids: number[] = new Array(count);
  for (let e = 0; e < count; e++) ids[e] = aS[e]! * tree.size + bS[e]!;
  const maxAgg = style.maxAggregateRadius ?? Infinity;
  const drawnRadius = (g: number): number => (g < tree.leafCount ? tree.radius[g]! : Math.min(tree.radius[g]!, maxAgg));

  // Endpoints (centroids) + per-edge colour are common to both styles.
  const sources = new Float32Array(count * 2);
  const targets = new Float32Array(count * 2);
  const colors = new Uint8Array(count * 4);
  // Cross-fade (#133): scale an edge's alpha by its least-visible present endpoint (off-screen endpoints
  // are opaque), so it fades with the aggregate/child it connects. `fa` undefined ⇒ full opacity.
  const fa = style.fadeAlpha;
  for (let e = 0; e < count; e++) {
    const g = aS[e]!;
    const h = bS[e]!;
    sources[e * 2] = tree.cx[g]!;
    sources[e * 2 + 1] = tree.cy[g]!;
    targets[e * 2] = tree.cx[h]!;
    targets[e * 2 + 1] = tree.cy[h]!;
    const [cr, cg, cb, ca] = style.colorOf(wS[e]!);
    colors[e * 4] = cr;
    colors[e * 4 + 1] = cg;
    colors[e * 4 + 2] = cb;
    if (fa) {
      const af = present[g] ? fa[g]! : 1;
      const bf = present[h] ? fa[h]! : 1;
      colors[e * 4 + 3] = Math.round(ca * Math.min(af, bf));
    } else {
      colors[e * 4 + 3] = ca;
    }
  }

  if (style.linkStyle === "half-arrow" && style.directed) {
    const radii = new Float32Array(count * 2);
    const widths = new Float32Array(count * 2);
    const bends = new Float32Array(count).fill(style.bend);
    for (let e = 0; e < count; e++) {
      radii[e * 2] = drawnRadius(aS[e]!);
      radii[e * 2 + 1] = drawnRadius(bS[e]!);
      const w = style.widthOf(wS[e]!);
      const opp = flowByPair.get(bS[e]! * tree.size + aS[e]!);
      widths[e * 2] = w;
      widths[e * 2 + 1] = opp === undefined ? w : style.widthOf(opp);
    }
    return { halfArrows: { sources, targets, radii, widths, bends, colors, count }, ids, flows: wS };
  }

  // Line style: bent/straight lines ∝ flow; directed → arrowheads set back to the target's (capped)
  // boundary along the bent end-tangent. Same colour as the line.
  const widths = new Float32Array(count);
  for (let e = 0; e < count; e++) widths[e] = style.widthOf(wS[e]!);
  const bends = new Float32Array(count).fill(style.bend);
  const lines: InstancedLinesData = style.bend
    ? { sources, targets, widths, colors, bends, samples: BENT_SAMPLES, count }
    : { sources, targets, widths, colors, count };
  if (!style.directed) return { lines, ids, flows: wS };

  // Arrowheads orient + set back in-shader (so screen sizeMode is honoured): pass the target centre
  // (already in `targets`) plus its draw radius; the shader puts the tip on the node boundary. A
  // one-sided **half** head only for bent links (so reciprocal heads don't collide); straight links
  // get the symmetric triangle — matching the non-LOD path (`half: bend !== 0`).
  const aRadii = new Float32Array(count);
  for (let e = 0; e < count; e++) aRadii[e] = drawnRadius(bS[e]!);
  const arrows: InstancedArrowsData = { sources, targets, radii: aRadii, sizes: new Float32Array(count).fill(style.arrowSize), colors, bends, half: style.bend !== 0, count };
  return { lines, arrows, ids, flows: wS };
}

/**
 * {@link superEdges} output: the per-style instanced batches plus parallel per-super-edge metadata.
 * `ids[e] = sourceTreeNode * tree.size + targetTreeNode` (the stable directed pair) and `flows[e]` is
 * its summed flow — both indexed by the instance/`gl_InstanceID` order shared across half-arrows and
 * lines/arrows. The Scene path (#138) keys link drawables by `ids`; GPU-readback link picking (#141)
 * maps a decoded instance index → `ids`/`flows` → a link HoverHit. (The WebGL fill draw ignores both.)
 */
export interface SuperEdgesData {
  halfArrows?: InstancedHalfArrowsData;
  lines?: InstancedLinesData;
  arrows?: InstancedArrowsData;
  ids: number[];
  flows?: number[];
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
  const widths = new Float32Array(count);
  for (let e = 0; e < count; e++) widths[e] = style.widthOf(graph.weight[e]!);
  const colors = linkColorBytes(graph.weight, count, style.colorOf);
  if (style.bend) {
    return { sources, targets, widths, colors, bends: new Float32Array(count).fill(style.bend), samples: BENT_SAMPLES, count };
  }
  return { sources, targets, widths, colors, count };
}

/** Style-derived line attributes (colours/widths/bends) that don't change on a position-only frame (#179). */
export interface LinkLinesStyleAttrs {
  widths: Float32Array;
  colors: Uint8Array;
  bends?: Float32Array;
  samples?: number;
}

/** The style-derived (accessor-run) attributes of {@link linkLines}, extracted so a position-only frame can
 *  reuse them (via {@link linkLinesFromCache}) instead of re-running `widthOf`/`colorOf` per edge (#179). */
export function linkLinesStyleAttrs(graph: NetworkGraph, style: LinkStyleResolved): LinkLinesStyleAttrs {
  const count = graph.edgeCount;
  const widths = new Float32Array(count);
  for (let e = 0; e < count; e++) widths[e] = style.widthOf(graph.weight[e]!);
  const colors = linkColorBytes(graph.weight, count, style.colorOf);
  if (style.bend) return { widths, colors, bends: new Float32Array(count).fill(style.bend), samples: BENT_SAMPLES };
  return { widths, colors };
}

/** Rebuild only the position-derived endpoints (from the current node positions), reusing cached
 *  style attributes (#179) — the per-layout-frame fast path for the no-LOD lines layer. */
export function linkLinesFromCache(graph: NetworkGraph, attrs: LinkLinesStyleAttrs): InstancedLinesData {
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
  const { widths, colors, bends, samples } = attrs;
  if (bends) return { sources, targets, widths, colors, bends, samples, count };
  return { sources, targets, widths, colors, count };
}

/**
 * Instanced **half-arrow** link data (#104 N6) — the "map of networks" directed-link glyph. Each
 * directed edge becomes one filled shape (see {@link halfLinkGeometry}): pinched to the source
 * centre, bowed around a shared centre curve, ending in a barbed arrowhead on the *target* node's
 * boundary. A reciprocal A→B / B→A pair is detected so each leaves room for the other's arrow at its
 * source end (`oppositeWidth`) and the two nest. `bend` is an absolute world-unit ⟂ offset (the
 * reference's `bend`). Width and colour encode the edge weight (which is the per-edge flow).
 */
export function halfArrowLinks(graph: NetworkGraph, style: HalfArrowStyleResolved): InstancedHalfArrowsData {
  const count = graph.edgeCount;
  const attrs = halfArrowLinksStyleAttrs(graph, style);
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
  return { sources, targets, ...attrs, count };
}

/** Style-derived half-arrow attributes (per-edge radii/widths/bends/colours) that don't change on a position frame (#179). */
export interface HalfArrowStyleAttrs {
  radii: Float32Array;
  widths: Float32Array;
  bends: Float32Array;
  colors: Uint8Array;
}

/** The style-derived attributes of {@link halfArrowLinks}, extracted so a position frame can reuse them (#179).
 *  Includes the reciprocal-pair `oppositeWidth` lookup — a function of weights/topology, not positions. */
export function halfArrowLinksStyleAttrs(graph: NetworkGraph, style: HalfArrowStyleResolved): HalfArrowStyleAttrs {
  const count = graph.edgeCount;
  const { nodeRadii, widthOf, colorOf, bend } = style;
  // Reciprocal lookup: key s*N+t → edge weight, so t→s can find s→t's width for `oppositeWidth`.
  const n = graph.nodeCount;
  const weightByPair = new Map<number, number>();
  for (let e = 0; e < count; e++) weightByPair.set(graph.source[e]! * n + graph.target[e]!, graph.weight[e]!);
  const radii = new Float32Array(count * 2);
  const widths = new Float32Array(count * 2);
  const bends = new Float32Array(count).fill(bend);
  for (let e = 0; e < count; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    radii[e * 2] = nodeRadii[s]!;
    radii[e * 2 + 1] = nodeRadii[t]!;
    const w = widthOf(graph.weight[e]!);
    const oppRaw = weightByPair.get(t * n + s);
    widths[e * 2] = w;
    widths[e * 2 + 1] = oppRaw === undefined ? w : widthOf(oppRaw);
  }
  const colors = linkColorBytes(graph.weight, count, colorOf);
  return { radii, widths, bends, colors };
}

/** Rebuild only the half-arrow endpoints from the current node positions, reusing cached style attributes (#179). */
export function halfArrowLinksFromCache(graph: NetworkGraph, attrs: HalfArrowStyleAttrs): InstancedHalfArrowsData {
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
  const { radii, widths, bends, colors } = attrs;
  return { sources, targets, radii, widths, bends, colors, count };
}

export interface HalfArrowStyleResolved {
  /** Per-node radii (world units) — source foot at r0, arrow tip on the target's r1 boundary. */
  nodeRadii: Float32Array;
  widthOf: (weight: number) => number;
  colorOf: (weight: number) => [number, number, number, number];
  /** Bend in **world units** (the reference's absolute ⟂ offset; sign picks the bow side). */
  bend: number;
}

export interface ArrowStyleResolved {
  size: number;
  /** Per-node radii (world units) — the tip is set back by the *target* node's radius. */
  nodeRadii: Float32Array;
  /** Per-edge RGBA from weight — the arrowhead always matches its link's colour. */
  colorOf: (weight: number) => [number, number, number, number];
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
  const radii = new Float32Array(count);
  for (let e = 0; e < count; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    sources[e * 2] = graph.positions[s * 2]!;
    sources[e * 2 + 1] = graph.positions[s * 2 + 1]!;
    targets[e * 2] = graph.positions[t * 2]!;
    targets[e * 2 + 1] = graph.positions[t * 2 + 1]!;
    // The tip is set back to the target node's boundary in-shader (oriented along the end tangent),
    // so it follows flow/degree-sized nodes and honours screen sizeMode.
    radii[e] = style.nodeRadii[t]!;
  }
  const sizes = new Float32Array(count).fill(style.size);
  // The arrowhead always takes its link's colour (no separate arrow fill).
  const colors = linkColorBytes(graph.weight, count, style.colorOf);
  if (bend) {
    return { sources, targets, radii, sizes, colors, bends: new Float32Array(count).fill(bend), half: style.half, count };
  }
  return { sources, targets, radii, sizes, colors, count };
}

/** Style-derived arrow attributes (per-edge radii/sizes/colours/bends) that don't change on a position frame (#179). */
export interface LinkArrowsStyleAttrs {
  radii: Float32Array;
  sizes: Float32Array;
  colors: Uint8Array;
  bends?: Float32Array;
  half?: boolean;
}

/** The style-derived attributes of {@link linkArrows}, extracted so a position frame can reuse them (#179). The
 *  target-node radius setback is style-derived (node radii come from the cached style, not per-frame positions). */
export function linkArrowsStyleAttrs(graph: NetworkGraph, style: ArrowStyleResolved): LinkArrowsStyleAttrs {
  const count = graph.edgeCount;
  const bend = style.bend ?? 0;
  const radii = new Float32Array(count);
  for (let e = 0; e < count; e++) radii[e] = style.nodeRadii[graph.target[e]!]!;
  const sizes = new Float32Array(count).fill(style.size);
  const colors = linkColorBytes(graph.weight, count, style.colorOf);
  if (bend) return { radii, sizes, colors, bends: new Float32Array(count).fill(bend), half: style.half };
  return { radii, sizes, colors };
}

/** Rebuild only the arrow endpoints from the current node positions, reusing cached style attributes (#179). */
export function linkArrowsFromCache(graph: NetworkGraph, attrs: LinkArrowsStyleAttrs): InstancedArrowsData {
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
  const { radii, sizes, colors, bends, half } = attrs;
  if (bends) return { sources, targets, radii, sizes, colors, bends, half, count };
  return { sources, targets, radii, sizes, colors, count };
}

/** Unit chord direction source→target (1,0 if degenerate). Used by the Scene/SVG arrow emitter. */
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
  /** When sizing by an additive metric, the per-leaf value + scale so LOD aggregates size by summed flow (else null). */
  nodeRadiusAggregate: { leafValue: Float32Array; radiusOf: (value: number) => number } | null;
  /** Per-leaf declutter importance (length `nodeCount`); summed up the tree → declutter priority. @see {@link resolveImportance} */
  importance: Float32Array;
  nodeFill: string;
  /** Representative scalar width (for unweighted super-edges + the arrow-size default). */
  linkWidth: number;
  /** Per-edge width from weight (a d3 scale or constant); for super-edges, applied to accumulated weight. */
  linkWidthOf: (weight: number) => number;
  /** Representative link colour (single colour, or a fallback for super-edges / Scene strokes). */
  linkStroke: string;
  /** Per-edge RGBA from weight; for super-edges, applied to accumulated weight. The arrow shares it. */
  linkColorOf: (weight: number) => [number, number, number, number];
  /** Per-edge CSS colour from weight (the Scene/SVG twin of {@link linkColorOf}). */
  linkStrokeOf: (weight: number) => string;
  /** How directed links draw: `"line"` + arrowhead, or a fused `"half-arrow"` (the map glyph). */
  linkStyle: LinkStyle;
  arrowSize: number;
  directed: boolean;
  /**
   * `"world"` (default) sizes glyphs in world units (they scale with zoom); `"screen"` sizes them in
   * constant pixels (the navigation register for large layouts — glyphs don't vanish when zoomed
   * out). Nodes, links and arrowheads all honour it in-shader.
   */
  sizeMode: "world" | "screen";
  /** Optional per-node RGBA fill (categorical module colours, #104 rework); overrides `nodeFill` when set. */
  nodeColors?: Uint8Array;
  /** Flow-border ring (#104 N6), or `null` when disabled (plain filled nodes). */
  flowBorder: ResolvedFlowBorder | null;
  /** Constant border ring (#104 rework), or `null`; used when no flow border is set. */
  constBorder: ConstBorder | null;
  /**
   * Link bend (#104 N6c): the quadratic-bezier control offset ⟂ to the chord. For `linkStyle:"line"`
   * it is a **fraction of chord length** (`0` ⇒ straight); for `linkStyle:"half-arrow"` it is an
   * **absolute world-unit** offset (the reference's `bend`, ~30), and the bow side is derived from the
   * link direction so a reciprocal pair nests.
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
  const halfArrow = style.linkStyle === "half-arrow" && style.directed;
  if (graph.edgeCount > 0) {
    if (halfArrow) {
      // One fused filled glyph per directed link (the map-of-networks look): the arrowhead is part of
      // the shape, so there's no separate arrows layer. The WebGL lane honours sizeMode — in "screen"
      // it projects both node centres to px and builds the shape in px (constant-px decorations).
      layers.push({
        name: "links",
        primitive: "half-arrows",
        halfArrows: halfArrowLinks(graph, { nodeRadii: style.nodeRadii, widthOf: style.linkWidthOf, colorOf: style.linkColorOf, bend }),
        sizeMode: style.sizeMode,
      });
    } else {
      layers.push({
        name: "links",
        primitive: "lines",
        lines: linkLines(graph, { widthOf: style.linkWidthOf, colorOf: style.linkColorOf, bend }),
        sizeMode: style.sizeMode,
      });
      if (style.directed) {
        layers.push({
          name: "arrows",
          primitive: "arrows",
          // Bent links get a one-sided half-arrow so reciprocal links don't collide (#104 N6c).
          arrows: linkArrows(graph, { size: style.arrowSize, nodeRadii: style.nodeRadii, colorOf: style.linkColorOf, bend, half: bend !== 0 }),
          // The arrowhead shader honours sizeMode in-shader (tip projected + set back in the working
          // space), so screen mode keeps a constant pixel head on the node boundary.
          sizeMode: style.sizeMode,
        });
      }
    }
  }
  layers.push({
    name: "nodes",
    primitive: "circles",
    circles: nodeCircles(graph, {
      radii: style.nodeRadii,
      fill: style.nodeFill,
      colors: style.nodeColors,
      border: style.flowBorder,
      constBorder: style.constBorder,
    }),
    sizeMode: style.sizeMode,
  });
  return layers;
}

/**
 * Style-derived attributes of the full-graph (no-LOD) layers that DON'T change on a position-only
 * layout frame (#179): link/arrow colours, widths, per-edge radii/sizes/bends. Cached once per
 * resolved-style version so a layout frame reuses them (via {@link networkLayersFromCache}) instead
 * of re-running the colour/width scale accessors ~O(edgeCount) times per frame. The node circles'
 * style attributes (radii/fill colours/flow-border) are cached whole (positions alias `graph.positions`,
 * so only a border layer needs a fresh position-derived pass — handled by re-running {@link nodeCircles}).
 */
export interface NoLodStyleCache {
  /** Which layer shape the cache is for (must match the current style to be reusable). */
  kind: "half-arrows" | "lines" | "lines+arrows" | "lines-only";
  sizeMode: "world" | "screen";
  halfArrows?: HalfArrowStyleAttrs;
  lines?: LinkLinesStyleAttrs;
  arrows?: LinkArrowsStyleAttrs;
}

/** Compute the {@link NoLodStyleCache} for the current resolved style (runs the scale accessors ONCE). */
export function noLodStyleCache(graph: NetworkGraph, style: ResolvedNetworkStyle): NoLodStyleCache {
  const bend = style.linkBend;
  const halfArrow = style.linkStyle === "half-arrow" && style.directed;
  const sizeMode = style.sizeMode;
  if (graph.edgeCount === 0) return { kind: "lines-only", sizeMode };
  if (halfArrow) {
    return {
      kind: "half-arrows",
      sizeMode,
      halfArrows: halfArrowLinksStyleAttrs(graph, { nodeRadii: style.nodeRadii, widthOf: style.linkWidthOf, colorOf: style.linkColorOf, bend }),
    };
  }
  const lines = linkLinesStyleAttrs(graph, { widthOf: style.linkWidthOf, colorOf: style.linkColorOf, bend });
  if (style.directed) {
    const arrows = linkArrowsStyleAttrs(graph, { size: style.arrowSize, nodeRadii: style.nodeRadii, colorOf: style.linkColorOf, bend, half: bend !== 0 });
    return { kind: "lines+arrows", sizeMode, lines, arrows };
  }
  return { kind: "lines", sizeMode, lines };
}

/**
 * Assemble the no-LOD layers on a **position-only** frame (#179): rebuild ONLY the position-derived
 * endpoints/node-centres from `graph.positions`, reusing the cached style attributes in `cache`. Does
 * NOT run the colour/width scale accessors. The `nodes` layer re-runs {@link nodeCircles} (cheap:
 * centers alias `graph.positions`, colours/radii come from the cached `style`; only a border layer does
 * an O(node) position pass). Must be called with the SAME `style` version the cache was built from.
 */
export function networkLayersFromCache(graph: NetworkGraph, style: ResolvedNetworkStyle, cache: NoLodStyleCache): InstancedLayer[] {
  const layers: InstancedLayer[] = [];
  const sizeMode = style.sizeMode;
  if (graph.edgeCount > 0) {
    if (cache.kind === "half-arrows" && cache.halfArrows) {
      layers.push({ name: "links", primitive: "half-arrows", halfArrows: halfArrowLinksFromCache(graph, cache.halfArrows), sizeMode });
    } else if (cache.lines) {
      layers.push({ name: "links", primitive: "lines", lines: linkLinesFromCache(graph, cache.lines), sizeMode });
      if (cache.arrows) {
        layers.push({ name: "arrows", primitive: "arrows", arrows: linkArrowsFromCache(graph, cache.arrows), sizeMode });
      }
    }
  }
  layers.push({
    name: "nodes",
    primitive: "circles",
    circles: nodeCircles(graph, {
      radii: style.nodeRadii,
      fill: style.nodeFill,
      colors: style.nodeColors,
      border: style.flowBorder,
      constBorder: style.constBorder,
    }),
    sizeMode,
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

/** Emit each link as a stroked drawable, keyed by edge index; width from its weight via `widthOf`. With `bend` it bows into a quadratic bezier (#104 N6c). */
export function emitLinks(g: GroupBuilder, graph: NetworkGraph, widthOf: (weight: number) => number, bend = 0): void {
  for (let e = 0; e < graph.edgeCount; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    const sx = graph.positions[s * 2]!;
    const sy = graph.positions[s * 2 + 1]!;
    const tx = graph.positions[t * 2]!;
    const ty = graph.positions[t * 2 + 1]!;
    const width = widthOf(graph.weight[e]!);
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
 *
 * `bake` (default 1) is the **screen-sizeMode** bake (the same trick as {@link emitHalfLinks}): the
 * shape is solved in pixel space (positions × `bake`, with `size`/`nodeRadii` already in px) and scaled
 * back by `1/bake`, so the Scene's ×k view transform reproduces the WebGL constant-px arrowhead — tip
 * size *and* the node-boundary setback. Without it, the world-unit setback grows with zoom and the head
 * drifts off the node. The end-tangent direction is invariant under the uniform ×bake, so only the
 * setback/size scale. `bake = 1` (world mode) leaves world geometry untouched.
 */
export function emitArrows(g: GroupBuilder, graph: NetworkGraph, size: number, nodeRadii: Float32Array, bend = 0, half = false, bake = 1): void {
  const inv = 1 / bake;
  for (let e = 0; e < graph.edgeCount; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    const sx = graph.positions[s * 2]! * bake;
    const sy = graph.positions[s * 2 + 1]! * bake;
    const tx = graph.positions[t * 2]! * bake;
    const ty = graph.positions[t * 2 + 1]! * bake;
    const [ux, uy] = bend ? bentEndTangent(sx, sy, tx, ty, bend) : straightUnit(sx, sy, tx, ty);
    const px = -uy;
    const py = ux;
    const setback = nodeRadii[t]!;
    const tipX = tx - ux * setback;
    const tipY = ty - uy * setback;
    const baseX = tipX - ux * 2 * size;
    const baseY = tipY - uy * 2 * size;
    g.drawable(e, (ctx) => {
      // Solve in px×bake space, emit ÷bake so the ×k view restores the constant-px shape.
      ctx.moveTo(tipX * inv, tipY * inv);
      // Half-arrow: base on one side of the centreline only (tip → centre-base → +side).
      ctx.lineTo((half ? baseX : baseX - px * size) * inv, (half ? baseY : baseY - py * size) * inv);
      ctx.lineTo((baseX + px * size) * inv, (baseY + py * size) * inv);
      ctx.closePath();
    });
  }
}

/**
 * Emit each directed link as a filled **half-arrow** drawable (#104 N6) — the SVG/Canvas twin of the
 * WebGL half-arrow lane, tracing the exact reference path via {@link traceHalfLink}. Keyed by edge
 * index; the fill colour is set per-edge by the layer. `widthOf`/`bend` and the reciprocal-width
 * lookup mirror {@link halfArrowLinks}, so vector export matches the GPU render.
 *
 * `bake` (default 1) supports the **screen-sizeMode** bake: the shape is solved in pixel space (node
 * centres × `bake`, with `nodeRadii`/`widthOf`/`bend` already in px) and the result scaled by `1/bake`,
 * so the Scene's ×k transform reproduces the WebGL constant-px render *exactly* — including the
 * non-linear tip/bend terms, which a naive per-size division would distort (and worse the deeper you
 * zoom). `bake = 1` (world mode) leaves world sizes untouched.
 */
export function emitHalfLinks(
  g: GroupBuilder,
  graph: NetworkGraph,
  nodeRadii: Float32Array,
  widthOf: (weight: number) => number,
  bend: number,
  bake = 1,
): void {
  const n = graph.nodeCount;
  const weightByPair = new Map<number, number>();
  for (let e = 0; e < graph.edgeCount; e++) weightByPair.set(graph.source[e]! * n + graph.target[e]!, graph.weight[e]!);
  for (let e = 0; e < graph.edgeCount; e++) {
    const s = graph.source[e]!;
    const t = graph.target[e]!;
    const oppRaw = weightByPair.get(t * n + s);
    // Solve in pixel space (positions × bake, px sizes); scale the result back by 1/bake to emit world
    // geometry the Scene's view transform restores to pixels. bake = 1 ⇒ plain world geometry.
    const geom = halfLinkGeometry({
      x0: graph.positions[s * 2]! * bake,
      y0: graph.positions[s * 2 + 1]! * bake,
      r0: nodeRadii[s]!,
      x1: graph.positions[t * 2]! * bake,
      y1: graph.positions[t * 2 + 1]! * bake,
      r1: nodeRadii[t]!,
      width: widthOf(graph.weight[e]!),
      oppositeWidth: oppRaw === undefined ? widthOf(graph.weight[e]!) : widthOf(oppRaw),
      bend,
    });
    if (!geom) continue;
    const out = bake === 1 ? geom : scaleHalfLink(geom, 1 / bake);
    g.drawable(e, (ctx) => traceHalfLink(out, ctx));
  }
}

// ---------------------------------------------------------------------------
// LOD frontier → Scene tracers (#138). The retained-Scene twin of the WebGL
// instanced LOD lane: trace the *same* SoA {@link frontierCircles}/{@link frontierHalos}/
// {@link superEdges} produce, so Canvas/SVG draw the byte-identical aggregate map and
// toSVG() exports a level-of-detail network. Each drawable is keyed by a **stable
// tree-node id** (frontier node, or directed super-edge pair) so the retained-scene
// diff stays stable across re-cuts — a module that survives a re-cut keeps its slot
// (and any selection/highlight on it). Colours come from the layer's fill/stroke
// accessor reading the SoA byte buffers via {@link rgbaCss}, parallel to these traces.
// ---------------------------------------------------------------------------

/** RGBA byte quad at instance `i` of a packed colour buffer → a CSS `rgba()` string for a Scene accessor. */
export function rgbaCss(colors: Uint8Array, i: number): string {
  return `rgba(${colors[i * 4]},${colors[i * 4 + 1]},${colors[i * 4 + 2]},${colors[i * 4 + 3]! / 255})`;
}

/**
 * Trace the LOD frontier's **fill discs** (the inner disc under any border ring) into a Scene group,
 * keyed by tree-node id. Mirrors {@link frontierCircles}' radius/border semantics: with a border, the
 * fill radius is `radius·(1 − borderFraction)` — the smaller disc the {@link emitNodes} stacked-disc
 * border path also draws (the border disc itself is {@link traceFrontierBorders}).
 */
export function traceFrontierFills(g: GroupBuilder, circles: InstancedCirclesData, frontier: Uint32Array): void {
  const { centers, radii, borders } = circles;
  for (let i = 0; i < circles.count; i++) {
    const inner = borders ? radii[i]! * (1 - borders[i]!) : radii[i]!;
    g.point(frontier[i]!, centers[i * 2]!, centers[i * 2 + 1]!, inner);
  }
}

/** Trace the LOD frontier's **border discs** (the outer ring-colour disc under each fill), keyed by tree-node id. Empty when the frontier has no border. */
export function traceFrontierBorders(g: GroupBuilder, circles: InstancedCirclesData, frontier: Uint32Array): void {
  if (!circles.borders) return;
  const { centers, radii } = circles;
  for (let i = 0; i < circles.count; i++) {
    g.point(frontier[i]!, centers[i * 2]!, centers[i * 2 + 1]!, radii[i]!);
  }
}

/**
 * Trace the aggregate-outline **halo rings** (a `width`-thick stroked circle a `gap` outside each
 * collapsed-module glyph) into a Scene group, keyed by the halo's tree-node id. In `screen` sizeMode the
 * ring is pinned at a constant pixel size around the projected centre via the drawable `anchor` (the
 * same mechanism a `point` uses); in world mode it's plain world geometry. The stroke colour comes from
 * the layer accessor reading `halos.borderColors`.
 */
export function traceFrontierHalos(g: GroupBuilder, halos: FrontierHalosData, screen: boolean): void {
  const { centers, radii, borders, ids } = halos;
  for (let k = 0; k < halos.count; k++) {
    const cx = centers[k * 2]!;
    const cy = centers[k * 2 + 1]!;
    const outer = radii[k]!;
    const w = outer * borders[k]!; // ring thickness (= style.width, in the active sizeMode's units)
    const mid = outer - w / 2; // stroke centreline radius, so the ring's outer edge sits at `outer`
    g.drawable(
      ids[k]!,
      (ctx) => {
        ctx.moveTo(cx + mid, cy);
        ctx.arc(cx, cy, mid, 0, Math.PI * 2);
      },
      screen ? { lineWidth: w, anchor: [cx, cy] } : { lineWidth: w },
    );
  }
}

/**
 * Trace LOD super-edges as filled **half-arrows** (the directed map glyph), keyed by super-edge pair id.
 * The Scene twin of the WebGL half-arrow lane: builds each shape from the {@link superEdges} SoA via the
 * same {@link halfLinkGeometry}/{@link traceHalfLink} reference path as {@link emitHalfLinks}, with the
 * identical `bake` trick — in `screen` sizeMode pass `bake = k` so centres are solved in pixel space and
 * the result scaled by `1/bake`, reproducing the constant-px GPU render under the Scene's ×k transform.
 */
export function traceSuperHalfArrows(g: GroupBuilder, ha: InstancedHalfArrowsData, ids: ArrayLike<number>, bake = 1): void {
  const inv = 1 / bake;
  for (let e = 0; e < ha.count; e++) {
    const geom = halfLinkGeometry({
      x0: ha.sources[e * 2]! * bake,
      y0: ha.sources[e * 2 + 1]! * bake,
      r0: ha.radii[e * 2]!,
      x1: ha.targets[e * 2]! * bake,
      y1: ha.targets[e * 2 + 1]! * bake,
      r1: ha.radii[e * 2 + 1]!,
      width: ha.widths[e * 2]!,
      oppositeWidth: ha.widths[e * 2 + 1]!,
      bend: ha.bends[e]!,
    });
    if (!geom) continue;
    const out = bake === 1 ? geom : scaleHalfLink(geom, inv);
    g.drawable(ids[e]!, (ctx) => traceHalfLink(out, ctx));
  }
}

/** Trace LOD super-edges as **stroked lines** (straight or bent, ∝ flow), keyed by super-edge pair id. World-positioned with a per-line width; the layer's sizeMode applies the px stroke width in screen mode (no bake — endpoints are world, the chord-fraction bend scales with them). */
export function traceSuperLines(g: GroupBuilder, lines: InstancedLinesData, ids: ArrayLike<number>): void {
  const { sources, targets, widths, bends } = lines;
  for (let e = 0; e < lines.count; e++) {
    const sx = sources[e * 2]!;
    const sy = sources[e * 2 + 1]!;
    const tx = targets[e * 2]!;
    const ty = targets[e * 2 + 1]!;
    const bend = bends ? bends[e]! : 0;
    g.drawable(
      ids[e]!,
      (ctx) => {
        ctx.moveTo(sx, sy);
        if (bend) {
          const [cxp, cyp] = bezierControl(sx, sy, tx, ty, bend);
          ctx.quadraticCurveTo(cxp, cyp, tx, ty);
        } else {
          ctx.lineTo(tx, ty);
        }
      },
      { lineWidth: widths[e]! },
    );
  }
}

/**
 * Trace LOD super-edges' directed **arrowheads** as filled triangles, keyed by super-edge pair id —
 * the Scene twin of {@link emitArrows}, reading the {@link superEdges} SoA (target centre + draw radius
 * for the boundary setback, size, bend, and `half` for one-sided heads on bent links). Same `bake` trick
 * for `screen` sizeMode: solve in pixel space (×bake) and emit ÷bake.
 */
export function traceSuperArrows(g: GroupBuilder, arrows: InstancedArrowsData, ids: ArrayLike<number>, bake = 1): void {
  const inv = 1 / bake;
  const half = arrows.half === true;
  for (let e = 0; e < arrows.count; e++) {
    const sx = arrows.sources[e * 2]! * bake;
    const sy = arrows.sources[e * 2 + 1]! * bake;
    const tx = arrows.targets[e * 2]! * bake;
    const ty = arrows.targets[e * 2 + 1]! * bake;
    const bend = arrows.bends ? arrows.bends[e]! : 0;
    const [ux, uy] = bend ? bentEndTangent(sx, sy, tx, ty, bend) : straightUnit(sx, sy, tx, ty);
    const px = -uy;
    const py = ux;
    const setback = arrows.radii[e]!;
    const size = arrows.sizes[e]!;
    const tipX = tx - ux * setback;
    const tipY = ty - uy * setback;
    const baseX = tipX - ux * 2 * size;
    const baseY = tipY - uy * 2 * size;
    g.drawable(ids[e]!, (ctx) => {
      ctx.moveTo(tipX * inv, tipY * inv);
      ctx.lineTo((half ? baseX : baseX - px * size) * inv, (half ? baseY : baseY - py * size) * inv);
      ctx.lineTo((baseX + px * size) * inv, (baseY + py * size) * inv);
      ctx.closePath();
    });
  }
}

// ---------------------------------------------------------------------------
// Pie wedges (#171) — the physical-view glyph for overlapping module membership. WebGL: one instanced
// wedge per module a physical node spans (physicalPieInstances). Canvas/SVG + toSVG: filled arc sectors
// (tracePieWedges). Single-module physical nodes are NOT drawn here — they render as solid discs on the
// nodeCircles lane, so only ≥2-module ("overlapping") physical nodes get a pie.
// ---------------------------------------------------------------------------

/** Radius input for pie glyphs (active `sizeMode` units): a constant, or one radius per physical node. */
export type PieRadius = number | ArrayLike<number>;

/** The angle (radians) a wedge fraction `f ∈ [0,1]` maps to — the SAME convention as INSTANCED_PIE_FS
 *  (`atan2(y,x)`, CCW from +x in world coords), so WebGL and the Canvas/SVG arcs partition a pie identically. */
const TAU = Math.PI * 2;

/**
 * Build instanced pie wedges from {@link PhysicalPieWedges} for the physical nodes that span ≥2 modules
 * — one instance per wedge (its `[startFrac, endFrac]` angular sector). `radius` is per-physical (or a
 * constant) in the active `sizeMode`'s units. Group id = the physical node id, so a hover/select lights
 * the whole pie (#162). Build-once: called on a data/module change, not per frame.
 */
export function physicalPieInstances(wedges: PhysicalPieWedges, positions: ArrayLike<number>, radius: PieRadius): InstancedPieData {
  const { offset, end, color, wedgeCount } = wedges;
  const physicalCount = wedgeCount.length;
  const radiusAt = typeof radius === "number" ? () => radius : (p: number) => radius[p]!;
  let total = 0;
  for (let p = 0; p < physicalCount; p++) if (wedgeCount[p]! >= 2) total += wedgeCount[p]!;

  const centers = new Float32Array(total * 2);
  const radii = new Float32Array(total);
  const angles = new Float32Array(total * 2);
  const colors = new Uint8Array(total * 4);
  const groups = new Float32Array(total);
  let w = 0;
  for (let p = 0; p < physicalCount; p++) {
    if (wedgeCount[p]! < 2) continue;
    const cx = positions[2 * p]!;
    const cy = positions[2 * p + 1]!;
    const r = radiusAt(p);
    let a0 = 0;
    for (let k = offset[p]!; k < offset[p + 1]!; k++) {
      const a1 = end[k]!;
      centers[2 * w] = cx;
      centers[2 * w + 1] = cy;
      radii[w] = r;
      angles[2 * w] = a0;
      angles[2 * w + 1] = a1;
      const [rr, gg, bb, aa] = toRGBA(color[k]!);
      colors[4 * w] = rr;
      colors[4 * w + 1] = gg;
      colors[4 * w + 2] = bb;
      colors[4 * w + 3] = aa;
      groups[w] = p;
      a0 = a1;
      w++;
    }
  }
  return { centers, radii, angles, colors, groups, count: total };
}

/**
 * Trace pie wedges into a Scene group for the retained (Canvas/SVG) backends + `toSVG()` export — the
 * vector twin of {@link physicalPieInstances}. Each overlapping physical node's wedges are drawn as
 * filled arc sectors keyed by their **flat wedge index** into {@link PhysicalPieWedges} (so the engine's
 * layer `fillOf` reads `wedges.color[index]`). In screen sizeMode the wedge is pinned at a constant
 * pixel size around the physical centre via the drawable `anchor` (all a pie's wedges share it).
 */
export function tracePieWedges(g: GroupBuilder, wedges: PhysicalPieWedges, positions: ArrayLike<number>, radius: PieRadius, screen: boolean): void {
  const { offset, end, wedgeCount } = wedges;
  const physicalCount = wedgeCount.length;
  const radiusAt = typeof radius === "number" ? () => radius : (p: number) => radius[p]!;
  for (let p = 0; p < physicalCount; p++) {
    if (wedgeCount[p]! < 2) continue;
    const cx = positions[2 * p]!;
    const cy = positions[2 * p + 1]!;
    const r = radiusAt(p);
    const anchor: [number, number] | undefined = screen ? [cx, cy] : undefined;
    let a0 = 0;
    for (let k = offset[p]!; k < offset[p + 1]!; k++) {
      const s = a0;
      const e = end[k]!;
      g.drawable(
        k,
        (ctx) => {
          ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, r, s * TAU, e * TAU, false);
          ctx.closePath();
        },
        anchor ? { anchor } : undefined,
      );
      a0 = e;
    }
  }
}
