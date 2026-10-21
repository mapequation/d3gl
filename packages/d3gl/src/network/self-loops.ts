/**
 * Self-link loops (#505): a link whose source and target are the same node has zero length, so the link
 * lanes draw nothing for it. This module turns each self-link into a small loop at its node's rim, sized
 * from the node's radius, as data the EXISTING link lanes already draw:
 *
 * - **teardrop**: one quadratic link from the rim at `θ + α` back to the rim at `θ − α`, bowed outward. It is
 *   an ordinary bent instance of the `lines` lane (or the `half-arrows` lane) with its two ends set off the
 *   node centre by `sourceOffsets` / `targetOffsets` (#509) — no new shader, no new primitive. The arrowhead
 *   is an ordinary `arrows` instance on the same offset ends, with a zero setback.
 * - **circle**: a ring of radius `ρ` whose centre sits just outside the rim, drawn by the `circles` lane as a
 *   transparent disc with a border ring in the link's width and colour; its arrowhead is a straight `arrows`
 *   instance tangent to the ring where it meets the rim.
 *
 * Everything is in the layer's size units: world units in `sizeMode: "world"`, px in `"screen"` (the offsets
 * are then px from the projected node centre, so a zoom moves nothing on the CPU on WebGL).
 *
 * Cost model: {@link selfLoopIndex} scans the edges ONCE per graph (O(E), cached by graph identity) and is
 * `null` when the graph has no self-link, so every other function here is skipped and a graph without
 * self-links pays nothing per frame. With `S` loops, a position frame costs O(S) (plus O(Σ degree of the
 * looped nodes) for `placement: "away"`); a zoom costs nothing on WebGL in either size mode.
 */
import type { NetworkGraph } from "./graph.js";
import { bezierControl, bentEndTangent } from "../core/half-link.js";
import type { InstancedLayer, GroupBuilder } from "../core/index.js";
import type { RGBAValue } from "./glyphs.js";

export type SelfLoopShape = "teardrop" | "circle";
/** `fixed`: every loop at `angle`. `away`: opposite the (weighted) mean direction of the node's neighbours. */
export type SelfLoopPlacement = "fixed" | "away";
/** Several self-links on one node: `sum` draws ONE loop of the summed weight; `nest` one loop each, growing. */
export type SelfLoopDuplicates = "sum" | "nest";

export interface SelfLoopOptions {
  shape: SelfLoopShape;
  placement: SelfLoopPlacement;
  duplicates: SelfLoopDuplicates;
  /** The fixed angle (radians, y down: `-π/4` = up-right), and the fallback for `away` when the neighbours cancel. */
  angle: number;
}

export const DEFAULT_SELF_LOOPS: SelfLoopOptions = { shape: "teardrop", placement: "away", duplicates: "nest", angle: -Math.PI / 4 };

/** The self-links of a graph, one entry per drawn loop. */
export interface SelfLoopIndex {
  /** The loop's node. */
  nodes: Uint32Array;
  /** The edge a pick on the loop reports (the first self-link of its node under `sum`). */
  edges: Uint32Array;
  /** The weight the loop is styled by (the summed weight under `sum`). */
  weights: Float32Array;
  /** The loop's rank on its node (0, 1, …; always 0 under `sum`): nested loops grow with it. */
  ranks: Uint16Array;
  count: number;
}

const indexCache = new WeakMap<NetworkGraph, Map<SelfLoopDuplicates, SelfLoopIndex | null>>();

/** The graph's self-links, grouped per {@link SelfLoopDuplicates}; `null` when it has none. O(E) once per
 *  graph and duplicates rule (edges are immutable; positions are not read here), then O(1). */
export function selfLoopIndex(graph: NetworkGraph, duplicates: SelfLoopDuplicates): SelfLoopIndex | null {
  let byRule = indexCache.get(graph);
  if (!byRule) indexCache.set(graph, (byRule = new Map()));
  const hit = byRule.get(duplicates);
  if (hit !== undefined) return hit;
  const built = buildSelfLoopIndex(graph.source, graph.target, graph.weight, graph.edgeCount, duplicates);
  byRule.set(duplicates, built);
  return built;
}

/** Pure core of {@link selfLoopIndex}. */
export function buildSelfLoopIndex(
  source: ArrayLike<number>,
  target: ArrayLike<number>,
  weight: ArrayLike<number>,
  edgeCount: number,
  duplicates: SelfLoopDuplicates,
): SelfLoopIndex | null {
  const loopEdges: number[] = [];
  for (let e = 0; e < edgeCount; e++) if (source[e] === target[e]) loopEdges.push(e);
  if (loopEdges.length === 0) return null;
  // Per node: its loops in edge order. A Map keeps this O(S), independent of the node count.
  const perNode = new Map<number, number[]>();
  for (const e of loopEdges) {
    const n = source[e] ?? 0;
    const list = perNode.get(n);
    if (list) list.push(e);
    else perNode.set(n, [e]);
  }
  const count = duplicates === "sum" ? perNode.size : loopEdges.length;
  const out: SelfLoopIndex = {
    nodes: new Uint32Array(count),
    edges: new Uint32Array(count),
    weights: new Float32Array(count),
    ranks: new Uint16Array(count),
    count,
  };
  let i = 0;
  for (const [n, list] of perNode) {
    if (duplicates === "sum") {
      let w = 0;
      for (const e of list) w += weight[e] ?? 0;
      out.nodes[i] = n;
      out.edges[i] = list[0] ?? 0;
      out.weights[i] = w;
      i++;
    } else {
      list.forEach((e, rank) => {
        out.nodes[i] = n;
        out.edges[i] = e;
        out.weights[i] = weight[e] ?? 0;
        out.ranks[i] = rank;
        i++;
      });
    }
  }
  return out;
}

/** Each loop's direction (radians, y down) per {@link SelfLoopPlacement}. `away` sums the unit vectors to the
 *  node's neighbours, weighted by link weight, and points opposite: O(Σ degree of the looped nodes). */
export function selfLoopAngles(graph: NetworkGraph, loops: SelfLoopIndex, placement: SelfLoopPlacement, angle: number, out = new Float32Array(loops.count)): Float32Array {
  const { positions, csr } = graph;
  for (let i = 0; i < loops.count; i++) {
    if (placement === "fixed") {
      out[i] = angle;
      continue;
    }
    const n = loops.nodes[i] ?? 0;
    const px = positions[2 * n] ?? 0;
    const py = positions[2 * n + 1] ?? 0;
    let sx = 0;
    let sy = 0;
    const end = csr.offsets[n + 1] ?? 0;
    for (let k = csr.offsets[n] ?? 0; k < end; k++) {
      const m = csr.neighbors[k] ?? n;
      if (m === n) continue;
      const dx = (positions[2 * m] ?? 0) - px;
      const dy = (positions[2 * m + 1] ?? 0) - py;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const w = csr.weights ? (csr.weights[k] ?? 1) : 1;
      sx += (w * dx) / len;
      sy += (w * dy) / len;
    }
    out[i] = Math.hypot(sx, sy) > 1e-9 ? Math.atan2(-sy, -sx) : angle;
  }
  return out;
}

/** Teardrop half-opening at the rim (radians): the loop leaves the rim at `θ + α` and returns at `θ − α`. */
const TEARDROP_HALF_OPENING = Math.PI / 6;
/** How far a rank-0 loop reaches beyond the rim, in node radii; each nested rank adds {@link NEST_STEP}. */
const LOOP_REACH = 1.1;
const NEST_STEP = 0.7;

/** Ends and bend of each teardrop, as offsets from the node centre (size units) and the lines lane's bend
 *  (control offset ⟂ to the chord, as a fraction of the chord, #296). The apex lies at `r·(1 + reach)` along θ. */
export function teardropGeometry(
  loops: SelfLoopIndex,
  angles: Float32Array,
  radiusOf: (node: number) => number,
  out = { sourceOffsets: new Float32Array(2 * loops.count), targetOffsets: new Float32Array(2 * loops.count), bends: new Float32Array(loops.count) },
): { sourceOffsets: Float32Array; targetOffsets: Float32Array; bends: Float32Array } {
  const a = TEARDROP_HALF_OPENING;
  for (let i = 0; i < loops.count; i++) {
    const r = radiusOf(loops.nodes[i] ?? 0);
    const t = angles[i] ?? 0;
    const reach = LOOP_REACH + NEST_STEP * (loops.ranks[i] ?? 0);
    out.sourceOffsets[2 * i] = r * Math.cos(t + a);
    out.sourceOffsets[2 * i + 1] = r * Math.sin(t + a);
    out.targetOffsets[2 * i] = r * Math.cos(t - a);
    out.targetOffsets[2 * i + 1] = r * Math.sin(t - a);
    // Apex of a quadratic = (mid + control)/2 along θ; mid lies at r·cos α. Solve the control distance D for an
    // apex at r(1 + reach), then express it as the lane's bend: `bezierControl` offsets by bend·(−dy, dx), and
    // for A = θ + α → B = θ − α that normal points along +θ, so the outward bow is a positive bend.
    const mid = r * Math.cos(a);
    const control = 2 * r * (1 + reach) - mid;
    const chord = 2 * r * Math.sin(a);
    out.bends[i] = chord > 0 ? (control - mid) / chord : 0;
  }
  return out;
}

/** Circle loop: radius `ρ` and centre distance `c` from the node centre (the ring overlaps the rim a little). */
export function circleLoop(r: number, rank: number): { rho: number; c: number } {
  const rho = 0.5 * r * (1 + NEST_STEP * rank);
  return { rho, c: r + 0.75 * rho };
}

/** The point where a circle loop meets the rim, and the ring's tangent there pointing back into the node,
 *  in the loop's frame (θ along +x). Used for the circle's arrowhead. */
export function circleLoopEntry(r: number, rho: number, c: number): { x: number; y: number; tx: number; ty: number } {
  const x = (c * c + r * r - rho * rho) / (2 * c);
  const y = Math.sqrt(Math.max(0, r * r - x * x));
  // Tangent ⟂ (X − Q), Q = (c, 0); pick the sense that heads back toward the node (−x).
  let tx = -y;
  let ty = x - c;
  if (tx > 0) {
    tx = -tx;
    ty = -ty;
  }
  const len = Math.hypot(tx, ty) || 1;
  return { x, y, tx: tx / len, ty: ty / len };
}

/** Rotate a loop-frame point (θ along +x) into the node frame. */
export function rotate(x: number, y: number, t: number): [number, number] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
}

/** Trace one teardrop into a path context: world-unit offsets around `(px, py)`. The Scene twin of the lane. */
export function traceTeardrop(
  ctx: { moveTo(x: number, y: number): void; quadraticCurveTo(cx: number, cy: number, x: number, y: number): void },
  px: number,
  py: number,
  sox: number,
  soy: number,
  tox: number,
  toy: number,
  bend: number,
): void {
  const sx = px + sox;
  const sy = py + soy;
  const tx = px + tox;
  const ty = py + toy;
  const [cx, cy] = bezierControl(sx, sy, tx, ty, bend);
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(cx, cy, tx, ty);
}

/** The resolved-style fields a loop reads (a structural slice of `ResolvedNetworkStyle`). */
export interface SelfLoopStyle {
  nodeRadii: Float32Array;
  linkWidthOf: (weight: number) => number;
  linkColorOf: (weight: number) => RGBAValue;
  directed: boolean;
  arrowSize: number;
  sizeMode: "world" | "screen";
}

/** Path samples of a teardrop strip (as the bent links). */
const LOOP_SAMPLES = 24;

/**
 * The instanced layers that draw a graph's self-links on WebGL: a `lines` (teardrop) or `circles` (circle)
 * layer, plus an `arrows` layer when directed. `[]` when the graph has no self-link. Instance `i` is loop `i`
 * of {@link selfLoopIndex}; its pick resolves to `loops.edges[i]`. O(S) (+ the `away` placement's degree sum).
 */
export function selfLoopLayers(graph: NetworkGraph, style: SelfLoopStyle, opts: SelfLoopOptions): InstancedLayer[] {
  const loops = selfLoopIndex(graph, opts.duplicates);
  if (!loops) return [];
  const S = loops.count;
  const angles = selfLoopAngles(graph, loops, opts.placement, opts.angle);
  const centres = new Float32Array(2 * S);
  const widths = new Float32Array(S);
  const colors = new Uint8Array(4 * S);
  for (let i = 0; i < S; i++) {
    const n = loops.nodes[i] ?? 0;
    centres[2 * i] = graph.positions[2 * n] ?? 0;
    centres[2 * i + 1] = graph.positions[2 * n + 1] ?? 0;
    const w = loops.weights[i] ?? 0;
    widths[i] = style.linkWidthOf(w);
    colors.set(style.linkColorOf(w), 4 * i);
  }
  const radiusOf = (n: number): number => style.nodeRadii[n] ?? 0;
  const sizeMode = style.sizeMode;
  const layers: InstancedLayer[] = [];
  if (opts.shape === "teardrop") {
    const g = teardropGeometry(loops, angles, radiusOf);
    layers.push({
      name: "self-links",
      primitive: "lines",
      sizeMode,
      lines: { sources: centres, targets: centres, widths, colors, bends: g.bends, samples: LOOP_SAMPLES, sourceOffsets: g.sourceOffsets, targetOffsets: g.targetOffsets, count: S },
    });
    if (style.directed)
      layers.push({
        name: "self-arrows",
        primitive: "arrows",
        sizeMode,
        arrows: { sources: centres, targets: centres, radii: new Float32Array(S), sizes: new Float32Array(S).fill(style.arrowSize), colors, bends: g.bends, sourceOffsets: g.sourceOffsets, targetOffsets: g.targetOffsets, count: S },
      });
    return layers;
  }
  // circle: a transparent disc whose border ring is the link (ring encoding: radius ρ + w/2, ring fraction w / that).
  const offsets = new Float32Array(2 * S);
  const radii = new Float32Array(S);
  const borders = new Float32Array(S);
  const fills = new Uint8Array(4 * S);
  const arrowFrom = new Float32Array(2 * S);
  const arrowTo = new Float32Array(2 * S);
  for (let i = 0; i < S; i++) {
    const r = radiusOf(loops.nodes[i] ?? 0);
    const t = angles[i] ?? 0;
    const { rho, c } = circleLoop(r, loops.ranks[i] ?? 0);
    const w = widths[i] ?? 0;
    offsets[2 * i] = c * Math.cos(t);
    offsets[2 * i + 1] = c * Math.sin(t);
    const outer = rho + w / 2;
    radii[i] = outer;
    borders[i] = outer > 0 ? w / outer : 0;
    const e = circleLoopEntry(r, rho, c);
    const [x, y] = rotate(e.x, e.y, t);
    const [tx, ty] = rotate(e.tx, e.ty, t);
    arrowTo[2 * i] = x;
    arrowTo[2 * i + 1] = y;
    arrowFrom[2 * i] = x - tx * 2 * style.arrowSize;
    arrowFrom[2 * i + 1] = y - ty * 2 * style.arrowSize;
  }
  layers.push({ name: "self-links", primitive: "circles", sizeMode, circles: { centers: centres, radii, colors: fills, borders, borderColors: colors, offsets, count: S } });
  if (style.directed)
    layers.push({
      name: "self-arrows",
      primitive: "arrows",
      sizeMode,
      arrows: { sources: centres, targets: centres, radii: new Float32Array(S), sizes: new Float32Array(S).fill(style.arrowSize), colors, sourceOffsets: arrowFrom, targetOffsets: arrowTo, count: S },
    });
  return layers;
}

/**
 * The Scene twin (Canvas / SVG): trace each loop into the `links` group, keyed by its edge. World mode traces
 * world geometry; screen mode traces px offsets around an `anchor` at the node centre, which the Scene draws
 * as `anchor′ + (p − anchor)`: constant px at every zoom with no re-bake.
 */
export function emitSelfLoops(g: GroupBuilder, graph: NetworkGraph, style: SelfLoopStyle, opts: SelfLoopOptions): void {
  const loops = selfLoopIndex(graph, opts.duplicates);
  if (!loops) return;
  const angles = selfLoopAngles(graph, loops, opts.placement, opts.angle);
  const radiusOf = (n: number): number => style.nodeRadii[n] ?? 0;
  const screen = style.sizeMode === "screen";
  const geo = opts.shape === "teardrop" ? teardropGeometry(loops, angles, radiusOf) : null;
  for (let i = 0; i < loops.count; i++) {
    const n = loops.nodes[i] ?? 0;
    const px = graph.positions[2 * n] ?? 0;
    const py = graph.positions[2 * n + 1] ?? 0;
    const lineWidth = style.linkWidthOf(loops.weights[i] ?? 0);
    const anchor: [number, number] | undefined = screen ? [px, py] : undefined;
    if (geo) {
      const so = geo.sourceOffsets;
      const to = geo.targetOffsets;
      g.drawable(loops.edges[i] ?? 0, (ctx) => traceTeardrop(ctx, px, py, so[2 * i] ?? 0, so[2 * i + 1] ?? 0, to[2 * i] ?? 0, to[2 * i + 1] ?? 0, geo.bends[i] ?? 0), { lineWidth, anchor });
    } else {
      const t = angles[i] ?? 0;
      const { rho, c } = circleLoop(radiusOf(n), loops.ranks[i] ?? 0);
      const cx = px + c * Math.cos(t);
      const cy = py + c * Math.sin(t);
      g.drawable(loops.edges[i] ?? 0, (ctx) => {
        ctx.moveTo(cx + rho, cy);
        ctx.arc(cx, cy, rho, 0, 2 * Math.PI);
      }, { lineWidth, anchor });
    }
  }
}

/** The Scene twin of the loop arrowheads, in the `arrows` group (filled). `bake` as {@link emitArrows}: screen
 *  mode solves in px around the node centre × bake and emits ÷ bake (re-baked with the other arrowheads). */
export function emitSelfLoopArrows(g: GroupBuilder, graph: NetworkGraph, style: SelfLoopStyle, opts: SelfLoopOptions, bake = 1): void {
  const loops = selfLoopIndex(graph, opts.duplicates);
  if (!loops) return;
  const angles = selfLoopAngles(graph, loops, opts.placement, opts.angle);
  const radiusOf = (n: number): number => style.nodeRadii[n] ?? 0;
  const geo = opts.shape === "teardrop" ? teardropGeometry(loops, angles, radiusOf) : null;
  const inv = 1 / bake;
  const size = style.arrowSize;
  for (let i = 0; i < loops.count; i++) {
    const n = loops.nodes[i] ?? 0;
    const px = (graph.positions[2 * n] ?? 0) * bake;
    const py = (graph.positions[2 * n + 1] ?? 0) * bake;
    let tipX: number, tipY: number, ux: number, uy: number;
    if (geo) {
      const sx = px + (geo.sourceOffsets[2 * i] ?? 0);
      const sy = py + (geo.sourceOffsets[2 * i + 1] ?? 0);
      tipX = px + (geo.targetOffsets[2 * i] ?? 0);
      tipY = py + (geo.targetOffsets[2 * i + 1] ?? 0);
      [ux, uy] = bentEndTangent(sx, sy, tipX, tipY, geo.bends[i] ?? 0);
    } else {
      const t = angles[i] ?? 0;
      const { rho, c } = circleLoop(radiusOf(n), loops.ranks[i] ?? 0);
      const e = circleLoopEntry(radiusOf(n), rho, c);
      const [x, y] = rotate(e.x, e.y, t);
      [ux, uy] = rotate(e.tx, e.ty, t);
      tipX = px + x;
      tipY = py + y;
    }
    const baseX = tipX - ux * 2 * size;
    const baseY = tipY - uy * 2 * size;
    g.drawable(loops.edges[i] ?? 0, (ctx) => {
      ctx.moveTo(tipX * inv, tipY * inv);
      ctx.lineTo((baseX + uy * size) * inv, (baseY - ux * size) * inv);
      ctx.lineTo((baseX - uy * size) * inv, (baseY + ux * size) * inv);
      ctx.closePath();
    });
  }
}

// TEMP(#505 prototype): the variant switch for the comparison images only. The real option is a style field.
let protoOptions: SelfLoopOptions = DEFAULT_SELF_LOOPS;
export function setSelfLoopPrototype(opts: Partial<SelfLoopOptions>): void {
  protoOptions = { ...DEFAULT_SELF_LOOPS, ...opts };
}
export function selfLoopPrototype(): SelfLoopOptions {
  return protoOptions;
}
