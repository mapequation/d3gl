/**
 * Self-link loops (#505): a link whose source and target are the same node has zero length, so the link
 * lanes draw nothing for it. This module turns a node's self-links into ONE small teardrop loop at its rim,
 * sized from the node's radius, as data the EXISTING link lanes already draw:
 *
 * - The loop is one quadratic link from the rim at `θ + α` back to the rim at `θ − α`, bowed outward: an
 *   ordinary bent instance of the `lines` lane (or the `half-arrows` lane) with its two ends set off the node
 *   centre by `sourceOffsets` / `targetOffsets` (#509). No new shader, no new primitive.
 * - A directed loop's arrowhead is an ordinary `arrows` instance on the same offset ends, with no setback
 *   (the ends already sit on the rim); the `half-arrow` style draws the loop as one half-arrow glyph.
 * - `θ` points away from the node's neighbours: opposite the weighted mean of the unit vectors to them, or
 *   {@link FALLBACK_ANGLE} when they cancel (or the node has none).
 *
 * A node cannot really have several self-links: the input's duplicates on one node aggregate into one loop,
 * styled (width, colour, flow) by their SUMMED weight. Picking the loop reports the node's first self-link.
 *
 * Everything is in the layer's size units: world units in `sizeMode: "world"`, px in `"screen"` (the offsets
 * are then px from the projected node centre, so a zoom moves nothing on the CPU on WebGL).
 *
 * Cost model: {@link selfLoopIndex} scans the edges ONCE per graph (O(E), cached by graph identity) and is
 * `null` without self-links, so no loop cache, layer or Scene drawable exists and a graph without self-links
 * pays nothing per frame. With `S` loops, {@link selfLoopCache} is O(S) once per style version, and a
 * position frame ({@link updateSelfLoops}) is O(S + Σ degree of the looped nodes), in place: no allocation.
 */
import type { NetworkGraph } from "./graph.js";
import { bezierControl, bentEndTangent, chordBend, halfLinkGeometry, scaleHalfLink, traceHalfLink } from "../core/half-link.js";
import type { InstancedLayer, GroupBuilder } from "../core/index.js";
import type { RGBAValue } from "./glyphs.js";
import type { StableColumns } from "../core/stable-columns.js";

/** The direction of a loop whose node has no neighbours to point away from (radians, y down: up-right). */
export const FALLBACK_ANGLE = -Math.PI / 4;
/** Teardrop half-opening at the rim (radians): the loop leaves the rim at `θ + α` and returns at `θ − α`. */
export const TEARDROP_HALF_OPENING = Math.PI / 6;
/** How far the loop's apex reaches beyond the rim, in node radii. */
export const LOOP_REACH = 1.1;
/**
 * The teardrop's bend as the link lanes read it (control offset ⟂ to the chord, as a fraction of the chord,
 * #296). The apex of a quadratic lies at `(mid + control)/2`; with the chord's midpoint at `r·cos α` along θ
 * and the apex at `r(1 + reach)`, the control sits at `2r(1 + reach) − r·cos α`, so the bend is
 * `(control − mid) / chord` with chord `2r·sin α`: the radius cancels, one constant for every loop.
 * `bezierControl` offsets by `bend·(−dy, dx)`, which for `θ + α → θ − α` points along `+θ`: positive = outward.
 */
export const TEARDROP_BEND = (2 * (1 + LOOP_REACH) - 2 * Math.cos(TEARDROP_HALF_OPENING)) / (2 * Math.sin(TEARDROP_HALF_OPENING));

/** The loops of a graph: one per node with a self-link, in ascending order of `edges`. */
export interface SelfLoopIndex {
  /** The loop's node. */
  nodes: Uint32Array;
  /** The edge a pick on the loop reports: the node's FIRST self-link (its duplicates are summed into it). */
  edges: Uint32Array;
  /** The weight the loop is styled by: the sum of the node's self-link weights. */
  weights: Float32Array;
  count: number;
}

const indexCache = new WeakMap<NetworkGraph, SelfLoopIndex | null>();

/** The graph's loops, `null` when it has no self-link. O(E) once per graph (edges are immutable), then O(1). */
export function selfLoopIndex(graph: NetworkGraph): SelfLoopIndex | null {
  const hit = indexCache.get(graph);
  if (hit !== undefined) return hit;
  const built = buildSelfLoopIndex(graph.source, graph.target, graph.weight, graph.edgeCount);
  indexCache.set(graph, built);
  return built;
}

/** Pure core of {@link selfLoopIndex}: one loop per node, its duplicates' weights summed. */
export function buildSelfLoopIndex(source: ArrayLike<number>, target: ArrayLike<number>, weight: ArrayLike<number>, edgeCount: number): SelfLoopIndex | null {
  // Per node: the index of its loop, in order of its first self-link (so `edges` ascends). A Map keeps this
  // O(S), independent of the node count.
  const loopOf = new Map<number, number>();
  const nodes: number[] = [];
  const edges: number[] = [];
  const weights: number[] = [];
  for (let e = 0; e < edgeCount; e++) {
    const n = source[e] ?? -1;
    if (n !== target[e]) continue;
    const w = weight[e] ?? 0;
    const i = loopOf.get(n);
    if (i === undefined) {
      loopOf.set(n, nodes.length);
      nodes.push(n);
      edges.push(e);
      weights.push(w);
    } else weights[i] = (weights[i] ?? 0) + w;
  }
  if (nodes.length === 0) return null;
  return { nodes: Uint32Array.from(nodes), edges: Uint32Array.from(edges), weights: Float32Array.from(weights), count: nodes.length };
}

/** The loop drawn for edge `e` (its node's first self-link), or -1. O(log S): `edges` ascends. */
export function selfLoopOfEdge(loops: SelfLoopIndex, e: number): number {
  let lo = 0;
  let hi = loops.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = loops.edges[mid] ?? 0;
    if (m === e) return mid;
    if (m < e) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** The CSR slice {@link selfLoopAngles} reads (a structural slice of the graph's `csr`). */
interface Adjacency {
  offsets: ArrayLike<number>;
  neighbors: ArrayLike<number>;
  weights?: ArrayLike<number>;
}

/** Each loop's direction (radians, y down), into `out`: opposite the weighted mean of the unit vectors from
 *  its node to its neighbours, or {@link FALLBACK_ANGLE}. With `nodeOffsets` (#509: a state node drawn at its
 *  physical node's centre plus a px offset), a neighbour at the same centre — a state node of the same physical
 *  node — points along the offsets' difference instead: a unit vector either way, so the angle is the same at
 *  every zoom. O(Σ degree of the looped nodes). */
export function selfLoopAngles(positions: ArrayLike<number>, csr: Adjacency, loops: SelfLoopIndex, out: Float32Array, nodeOffsets?: ArrayLike<number>): Float32Array {
  for (let i = 0; i < loops.count; i++) out[i] = selfLoopAngle(positions, csr, loops.nodes[i] ?? 0, nodeOffsets);
  return out;
}

/** One loop's direction, at node `n`: see {@link selfLoopAngles}. O(degree of `n`). */
function selfLoopAngle(positions: ArrayLike<number>, csr: Adjacency, n: number, nodeOffsets?: ArrayLike<number>): number {
  const px = positions[2 * n] ?? 0;
  const py = positions[2 * n + 1] ?? 0;
  let sx = 0;
  let sy = 0;
  const end = csr.offsets[n + 1] ?? 0;
  for (let k = csr.offsets[n] ?? 0; k < end; k++) {
    const m = csr.neighbors[k] ?? n;
    if (m === n) continue;
    let dx = (positions[2 * m] ?? 0) - px;
    let dy = (positions[2 * m + 1] ?? 0) - py;
    if (nodeOffsets && dx === 0 && dy === 0) {
      dx = (nodeOffsets[2 * m] ?? 0) - (nodeOffsets[2 * n] ?? 0);
      dy = (nodeOffsets[2 * m + 1] ?? 0) - (nodeOffsets[2 * n + 1] ?? 0);
    }
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const w = csr.weights ? (csr.weights[k] ?? 1) : 1;
    sx += (w * dx) / len;
    sy += (w * dy) / len;
  }
  return Math.hypot(sx, sy) > 1e-9 ? Math.atan2(-sy, -sx) : FALLBACK_ANGLE;
}

/** Each loop's two ends as offsets from its node centre (size units), into `sourceOffsets` / `targetOffsets`:
 *  on the rim at `θ + α` and `θ − α`. O(S). */
export function teardropEnds(loops: SelfLoopIndex, angles: ArrayLike<number>, radii: ArrayLike<number>, sourceOffsets: Float32Array, targetOffsets: Float32Array): void {
  const a = TEARDROP_HALF_OPENING;
  for (let i = 0; i < loops.count; i++) {
    const r = radii[loops.nodes[i] ?? 0] ?? 0;
    const t = angles[i] ?? 0;
    sourceOffsets[2 * i] = r * Math.cos(t + a);
    sourceOffsets[2 * i + 1] = r * Math.sin(t + a);
    targetOffsets[2 * i] = r * Math.cos(t - a);
    targetOffsets[2 * i + 1] = r * Math.sin(t - a);
  }
}

/**
 * The half-arrow lane's bend for a loop whose chord (its target end minus its source end) is `(dx, dy)`. The
 * half-arrow fixes its bow side by the chord's direction (`positiveCurvature`, so a reciprocal pair nests) and
 * multiplies by the bend's sign, where the line lane bows by the sign alone. The loop's chord runs
 * `θ + α → θ − α`, along `(sin θ, −cos θ)`, whose right-hand normal points away from the node, so the bend
 * takes the rule's sign. Pass the chord the drawing reads, not `θ`: at `θ ≈ 0` or `π` (a neighbour level with
 * its node) the chord is vertical and its x is rounding, so only that same x gives the side that path picks
 * (the WebGL lane reads it from the stored offsets, the Scene twin from its own ends).
 */
export function halfArrowLoopBend(dx: number, dy: number): number {
  const positive = dx > 0 || (dx === 0 && dy < 0);
  return positive ? TEARDROP_BEND : -TEARDROP_BEND;
}

/** Trace one teardrop into a path context, its ends at `(px, py)` + the offsets. The Scene twin of the lane. */
export function traceTeardrop(
  ctx: { moveTo(x: number, y: number): void; quadraticCurveTo(cx: number, cy: number, x: number, y: number): void },
  px: number,
  py: number,
  sox: number,
  soy: number,
  tox: number,
  toy: number,
): void {
  const sx = px + sox;
  const sy = py + soy;
  const tx = px + tox;
  const ty = py + toy;
  const [cx, cy] = bezierControl(sx, sy, tx, ty, TEARDROP_BEND);
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
  linkStyle: string;
  sizeMode: "world" | "screen";
}

/** Path samples of a loop strip (as the bent links). */
const LOOP_SAMPLES = 24;

/**
 * A graph's loops for one resolved style: the style columns, built once per style version ({@link selfLoopCache}),
 * and the position columns, rewritten IN PLACE by {@link updateSelfLoops} on every position frame. The layers
 * hand the renderer these same arrays every frame: the style columns then skip their upload (reference
 * identity), the centres upload as every link's ends do, and the end offsets upload by the `[0, S)` range.
 */
export interface SelfLoopCache {
  loops: SelfLoopIndex;
  sizeMode: "world" | "screen";
  /** The `half-arrow` style (directed): one half-arrow glyph per loop, no separate arrowhead. */
  halfArrow: boolean;
  /** A separate arrowhead per loop (directed, `line` style). */
  arrowheads: boolean;
  radii: Float32Array;
  // Style columns (per style version).
  widths: Float32Array;
  colors: Uint8Array;
  /** #162 highlight group per loop: its node (a loop is incident to its node at both ends). */
  groups: Float32Array;
  bends: Float32Array;
  arrowSizes: Float32Array;
  /** Zero setbacks: the arrowhead's and the half-arrow's tips sit on the offset ends, already on the rim. */
  zeroRadii: Float32Array;
  /** `[width, 0]` per loop: a loop has no reciprocal link to leave room for at its foot. */
  halfWidths: Float32Array;
  // Position columns (rewritten in place each position frame).
  centres: Float32Array;
  angles: Float32Array;
  sourceOffsets: Float32Array;
  targetOffsets: Float32Array;
  /** The half-arrow bends, double-buffered: a loop whose bow sign flips swaps to the other array, so the
   *  renderer (which uploads bends by reference) sees the change without an allocation. */
  halfBends: [Float32Array, Float32Array];
  halfBendSlot: 0 | 1;
  /** `[0, S)`: every end offset is rewritten each position frame (#509 in-place range upload). Absent on an LOD
   *  frame's subset ({@link selfLoopSubset}), whose columns are handed back unchanged when their values are. */
  changed?: Uint32Array;
  /** Per-loop `selected` flags (#162), on an LOD frame's subset (the no-LOD lane attaches its own). */
  selected?: Uint8Array;
}

/** Instrumentation for the per-frame guard: loop updates run, and loop instances they touched. */
export const selfLoopStats = { updates: 0, instances: 0 };

/** The {@link SelfLoopCache} for `graph` under `style`, `null` without self-links. O(S) (+ the O(E) index once
 *  per graph). Leaves the position columns for {@link updateSelfLoops}. */
export function selfLoopCache(graph: NetworkGraph, style: SelfLoopStyle): SelfLoopCache | null {
  const loops = selfLoopIndex(graph);
  if (!loops) return null;
  const S = loops.count;
  const widths = new Float32Array(S);
  const colors = new Uint8Array(4 * S);
  const halfWidths = new Float32Array(2 * S);
  for (let i = 0; i < S; i++) {
    const w = loops.weights[i] ?? 0;
    const width = style.linkWidthOf(w);
    widths[i] = width;
    halfWidths[2 * i] = width;
    colors.set(style.linkColorOf(w), 4 * i);
  }
  const halfArrow = style.directed && style.linkStyle === "half-arrow";
  return {
    loops,
    sizeMode: style.sizeMode,
    halfArrow,
    arrowheads: style.directed && !halfArrow,
    radii: style.nodeRadii,
    widths,
    colors,
    groups: Float32Array.from(loops.nodes),
    bends: new Float32Array(S).fill(TEARDROP_BEND),
    arrowSizes: new Float32Array(S).fill(style.arrowSize),
    zeroRadii: new Float32Array(halfArrow ? 2 * S : S),
    halfWidths,
    centres: new Float32Array(2 * S),
    angles: new Float32Array(S),
    sourceOffsets: new Float32Array(2 * S),
    targetOffsets: new Float32Array(2 * S),
    halfBends: [new Float32Array(halfArrow ? S : 0), new Float32Array(halfArrow ? S : 0)],
    halfBendSlot: 0,
    changed: Uint32Array.of(0, S),
  };
}

/** The position frame: each loop's centre, angle and ends (and half-arrow bend) from `graph.positions`, in
 *  place. With `nodeOffsets` (#509, the both view in screen sizeMode) each loop's ends also carry its node's
 *  offset, as the node and its links do. O(S + Σ degree of the looped nodes), no allocation. */
export function updateSelfLoops(graph: NetworkGraph, c: SelfLoopCache, nodeOffsets?: Float32Array): void {
  const { loops, centres, angles } = c;
  const S = loops.count;
  const pos = graph.positions;
  for (let i = 0; i < S; i++) {
    const n = loops.nodes[i] ?? 0;
    centres[2 * i] = pos[2 * n] ?? 0;
    centres[2 * i + 1] = pos[2 * n + 1] ?? 0;
  }
  selfLoopAngles(pos, graph.csr, loops, angles, nodeOffsets);
  teardropEnds(loops, angles, c.radii, c.sourceOffsets, c.targetOffsets);
  if (nodeOffsets) {
    const so = c.sourceOffsets;
    const to = c.targetOffsets;
    for (let i = 0; i < S; i++) {
      const n = loops.nodes[i] ?? 0;
      const ox = nodeOffsets[2 * n] ?? 0;
      const oy = nodeOffsets[2 * n + 1] ?? 0;
      so[2 * i] = (so[2 * i] ?? 0) + ox;
      so[2 * i + 1] = (so[2 * i + 1] ?? 0) + oy;
      to[2 * i] = (to[2 * i] ?? 0) + ox;
      to[2 * i + 1] = (to[2 * i + 1] ?? 0) + oy;
    }
  }
  if (c.halfArrow) {
    const cur = c.halfBends[c.halfBendSlot];
    const next = c.halfBends[c.halfBendSlot === 0 ? 1 : 0];
    let flipped = false;
    const so = c.sourceOffsets;
    const to = c.targetOffsets;
    for (let i = 0; i < S; i++) {
      // From the stored (float32) offsets, the values the lane's side rule reads.
      const b = halfArrowLoopBend((to[2 * i] ?? 0) - (so[2 * i] ?? 0), (to[2 * i + 1] ?? 0) - (so[2 * i + 1] ?? 0));
      next[i] = b;
      if (cur[i] !== b) flipped = true;
    }
    if (flipped) c.halfBendSlot = c.halfBendSlot === 0 ? 1 : 0;
  }
  selfLoopStats.updates++;
  selfLoopStats.instances += S;
}

/** The layer names the loops draw in (WebGL), between the links and the nodes. */
export const SELF_LOOP_LAYER = "self-loops";
export const SELF_LOOP_ARROW_LAYER = "self-loop-arrows";

/**
 * The instanced layers that draw the loops on WebGL, over the cache's current columns (call
 * {@link updateSelfLoops} first): a `lines` (or `half-arrows`) layer, plus an `arrows` layer for a directed
 * `line` style. Instance `i` is loop `i`; its pick resolves to `loops.edges[i]`. O(1): no array is built.
 */
export function selfLoopLayers(c: SelfLoopCache, pickable?: true, pickBase?: number): InstancedLayer[] {
  const pick = pickBase === undefined ? {} : { pickable, pickBase };
  const { centres, sourceOffsets, targetOffsets, changed, sizeMode } = c;
  const count = c.loops.count;
  const ends = { sourceOffsets, targetOffsets, endOffsetsChanged: changed };
  if (c.halfArrow)
    return [
      {
        name: SELF_LOOP_LAYER,
        primitive: "half-arrows",
        sizeMode,
        ...pick,
        halfArrows: { sources: centres, targets: centres, radii: c.zeroRadii, widths: c.halfWidths, bends: c.halfBends[c.halfBendSlot], colors: c.colors, samples: LOOP_SAMPLES, groups: c.groups, selected: c.selected, ...ends, count },
      },
    ];
  const layers: InstancedLayer[] = [
    { name: SELF_LOOP_LAYER, primitive: "lines", sizeMode, ...pick, lines: { sources: centres, targets: centres, widths: c.widths, colors: c.colors, bends: c.bends, samples: LOOP_SAMPLES, groups: c.groups, selected: c.selected, ...ends, count } },
  ];
  if (c.arrowheads)
    layers.push({
      name: SELF_LOOP_ARROW_LAYER,
      primitive: "arrows",
      sizeMode,
      ...pick,
      arrows: { sources: centres, targets: centres, radii: c.zeroRadii, sizes: c.arrowSizes, colors: c.colors, bends: c.bends, groups: c.groups, selected: c.selected, ...ends, count },
    });
  return layers;
}

/** Per-loop `selected` flags (#162) from the per-edge link flags: a loop is selected with its edge. O(S). */
export function selfLoopSelected(loops: SelfLoopIndex, linkSelected: Uint8Array): Uint8Array {
  const out = new Uint8Array(loops.count);
  for (let i = 0; i < loops.count; i++) out[i] = linkSelected[loops.edges[i] ?? 0] ?? 0;
  return out;
}

/**
 * The Scene twin (Canvas / SVG) of the `line`-style loops: one stroked drawable each in the `links` group,
 * keyed by its edge. World mode traces world geometry; screen mode traces px offsets around an `anchor` at
 * the node centre, which the Scene draws as `anchor′ + (p − anchor)`: constant px at every zoom, no re-bake.
 * Reads the columns {@link updateSelfLoops} wrote; each drawable captures its numbers, not the columns.
 */
export function emitSelfLoops(g: GroupBuilder, c: SelfLoopCache, idBase = 0): void {
  const { loops, centres, sourceOffsets: so, targetOffsets: to } = c;
  const screen = c.sizeMode === "screen";
  for (let i = 0; i < loops.count; i++) {
    const px = centres[2 * i] ?? 0;
    const py = centres[2 * i + 1] ?? 0;
    const sox = so[2 * i] ?? 0, soy = so[2 * i + 1] ?? 0, tox = to[2 * i] ?? 0, toy = to[2 * i + 1] ?? 0;
    g.drawable(idBase + (loops.edges[i] ?? 0), (ctx) => traceTeardrop(ctx, px, py, sox, soy, tox, toy), { lineWidth: c.widths[i] ?? 0, anchor: screen ? [px, py] : undefined });
  }
}

/** The Scene twin of the `half-arrow` loops: one filled half-arrow glyph each, keyed by its edge. `bake` as
 *  `emitHalfLinks`: screen mode solves in px around the node centre × bake and emits ÷ bake. */
export function emitSelfLoopHalfArrows(g: GroupBuilder, c: SelfLoopCache, bake = 1, idBase = 0): void {
  const { loops, centres, sourceOffsets: so, targetOffsets: to } = c;
  for (let i = 0; i < loops.count; i++) {
    const px = (centres[2 * i] ?? 0) * bake;
    const py = (centres[2 * i + 1] ?? 0) * bake;
    const x0 = px + (so[2 * i] ?? 0), y0 = py + (so[2 * i + 1] ?? 0);
    const x1 = px + (to[2 * i] ?? 0), y1 = py + (to[2 * i + 1] ?? 0);
    const width = c.widths[i] ?? 0;
    const geom = halfLinkGeometry({ x0, y0, r0: 0, x1, y1, r1: 0, width, oppositeWidth: 0, bend: chordBend(x0, y0, x1, y1, halfArrowLoopBend(x1 - x0, y1 - y0)) });
    if (!geom) continue;
    const out = bake === 1 ? geom : scaleHalfLink(geom, 1 / bake);
    g.drawable(idBase + (loops.edges[i] ?? 0), (ctx) => traceHalfLink(out, ctx));
  }
}

/** The Scene twin of the loop arrowheads, in the `arrows` group (filled). `bake` as `emitArrows`: screen mode
 *  solves in px around the node centre × bake and emits ÷ bake (re-baked with the other arrowheads). */
export function emitSelfLoopArrows(g: GroupBuilder, c: SelfLoopCache, size: number, bake = 1, idBase = 0): void {
  const { loops, centres, sourceOffsets: so, targetOffsets: to } = c;
  const inv = 1 / bake;
  for (let i = 0; i < loops.count; i++) {
    const px = (centres[2 * i] ?? 0) * bake;
    const py = (centres[2 * i + 1] ?? 0) * bake;
    const sx = px + (so[2 * i] ?? 0);
    const sy = py + (so[2 * i + 1] ?? 0);
    const tipX = px + (to[2 * i] ?? 0);
    const tipY = py + (to[2 * i + 1] ?? 0);
    const [ux, uy] = bentEndTangent(sx, sy, tipX, tipY, TEARDROP_BEND);
    const baseX = tipX - ux * 2 * size;
    const baseY = tipY - uy * 2 * size;
    g.drawable(idBase + (loops.edges[i] ?? 0), (ctx) => {
      ctx.moveTo(tipX * inv, tipY * inv);
      ctx.lineTo((baseX + uy * size) * inv, (baseY - ux * size) * inv);
      ctx.lineTo((baseX - uy * size) * inv, (baseY + ux * size) * inv);
      ctx.closePath();
    });
  }
}

/** Reusable state for the loops of an LOD frame (#505): each node's loop (−1 for none, built once per index, only
 *  for a graph with self-links), the frame's loop list, and the subset's id / angle columns. */
export interface KeptLoopsScratch {
  of: SelfLoopIndex | null;
  slot: Int32Array;
  list: Uint32Array;
  nodes: Uint32Array;
  edges: Uint32Array;
  weights: Float32Array;
  angles: Float32Array;
}

/** A fresh, empty {@link KeptLoopsScratch}. */
export function makeKeptLoopsScratch(): KeptLoopsScratch {
  return { of: null, slot: new Int32Array(0), list: new Uint32Array(0), nodes: new Uint32Array(0), edges: new Uint32Array(0), weights: new Float32Array(0), angles: new Float32Array(0) };
}

/** Instrumentation for the per-frame guards: LOD frames that listed loops, and the entries they read. */
export const keptLoopStats = { frames: 0, reads: 0 };

/**
 * The loops whose node is a kept leaf of a cut, as loop indices into `sc.list[0..m)`; returns `m`. The cheaper of
 * two passes: with `isKept` (the frame's gather stamps its kept leaves) and no more loops than glyphs, one over the
 * S loops; else one over the frontier against each node's loop slot (4 B per node, once per graph). So
 * O(min(S, frontier)), never more than the frame already reads, and never run for a graph without self-links.
 */
export function keptLeafLoops(loops: SelfLoopIndex, nodeCount: number, frontier: ArrayLike<number>, isKept: ((v: number) => boolean) | null, sc: KeptLoopsScratch): number {
  const S = loops.count;
  if (sc.list.length < S) sc.list = new Uint32Array(S);
  const list = sc.list;
  let m = 0;
  keptLoopStats.frames++;
  if (isKept && S <= frontier.length) {
    for (let i = 0; i < S; i++) if (isKept(loops.nodes[i] ?? 0)) list[m++] = i;
    keptLoopStats.reads += S;
    return m;
  }
  if (sc.of !== loops) {
    if (sc.slot.length !== nodeCount) sc.slot = new Int32Array(nodeCount);
    sc.slot.fill(-1);
    for (let i = 0; i < S; i++) sc.slot[loops.nodes[i] ?? 0] = i;
    sc.of = loops;
  }
  const slot = sc.slot;
  for (let k = 0; k < frontier.length; k++) {
    const g = frontier[k] ?? 0;
    if (g >= nodeCount) continue;
    const j = slot[g] ?? -1;
    if (j >= 0) list[m++] = j;
  }
  keptLoopStats.reads += frontier.length;
  return m;
}

/** Where an LOD frame draws its loops: the leaves' drawn centres, their cross-fade alpha, the per-edge selection. */
export interface LoopSubsetFrame {
  cx: ArrayLike<number>;
  cy: ArrayLike<number>;
  fade?: ArrayLike<number> | null;
  /** Per-edge `selected` flags (a loop takes its first self-link's). */
  linkSelected?: Uint8Array;
  nodeOffsets?: Float32Array;
}

/**
 * The loops `sc.list[0..m)` of `c` as a {@link SelfLoopCache} of their own (#505: an LOD frame's loops on kept
 * leaves), so {@link selfLoopLayers} and the Scene emitters draw it as they draw the whole set. Each loop's angle
 * and ends are solved here (O(m + Σ degree of their nodes)); its style is copied from `c`. Every column goes
 * through `memo` ({@link StableColumns}), so a frame whose loops and positions did not change hands back the
 * arrays the GPU holds and uploads nothing; memory: two arrays per column, ≈ 2 × 80 B per drawn loop, reused.
 */
export function selfLoopSubset(c: SelfLoopCache, graph: NetworkGraph, m: number, frame: LoopSubsetFrame, memo: StableColumns, sc: KeptLoopsScratch): SelfLoopCache {
  const list = sc.list;
  if (sc.nodes.length < m) {
    const cap = Math.max(m, 2 * sc.nodes.length);
    sc.nodes = new Uint32Array(cap);
    sc.edges = new Uint32Array(cap);
    sc.weights = new Float32Array(cap);
    sc.angles = new Float32Array(cap);
  }
  const { loops } = c;
  const { nodes, edges, weights, angles } = sc;
  const off = frame.nodeOffsets;
  for (let i = 0; i < m; i++) {
    const j = list[i] ?? 0;
    const n = loops.nodes[j] ?? 0;
    nodes[i] = n;
    edges[i] = loops.edges[j] ?? 0;
    weights[i] = loops.weights[j] ?? 0;
    angles[i] = selfLoopAngle(graph.positions, graph.csr, n, off);
  }
  const { cx, cy, fade, linkSelected } = frame;
  const a = TEARDROP_HALF_OPENING;
  const radii = c.radii;
  const endAt = (out: Float32Array, sign: number): void => {
    for (let i = 0; i < m; i++) {
      const n = nodes[i] ?? 0;
      const r = radii[n] ?? 0;
      const t = (angles[i] ?? 0) + sign * a;
      out[2 * i] = r * Math.cos(t) + (off ? (off[2 * n] ?? 0) : 0);
      out[2 * i + 1] = r * Math.sin(t) + (off ? (off[2 * n + 1] ?? 0) : 0);
    }
  };
  const sourceOffsets = memo.float32Into("loops.sourceOffsets", 2 * m, (out) => endAt(out, 1));
  const targetOffsets = memo.float32Into("loops.targetOffsets", 2 * m, (out) => endAt(out, -1));
  const centres = memo.float32Into("loops.centres", 2 * m, (out) => {
    for (let i = 0; i < m; i++) {
      const n = nodes[i] ?? 0;
      out[2 * i] = cx[n] ?? 0;
      out[2 * i + 1] = cy[n] ?? 0;
    }
  });
  const widths = memo.float32Into("loops.widths", m, (out) => {
    for (let i = 0; i < m; i++) out[i] = c.widths[list[i] ?? 0] ?? 0;
  });
  const colors = memo.uint8Into("loops.colors", 4 * m, (out) => {
    for (let i = 0; i < m; i++) {
      const j = 4 * (list[i] ?? 0);
      out[4 * i] = c.colors[j] ?? 0;
      out[4 * i + 1] = c.colors[j + 1] ?? 0;
      out[4 * i + 2] = c.colors[j + 2] ?? 0;
      // The cross-fade band (#139) fades a loop with its leaf, in its colour: the loop layer is not indexed.
      out[4 * i + 3] = Math.round((c.colors[j + 3] ?? 0) * (fade ? (fade[nodes[i] ?? 0] ?? 1) : 1));
    }
  });
  const groups = memo.float32Into("loops.groups", m, (out) => {
    for (let i = 0; i < m; i++) out[i] = nodes[i] ?? 0;
  });
  const bends = memo.float32Into("loops.bends", m, (out) => out.fill(TEARDROP_BEND));
  const arrowSizes = memo.float32Into("loops.arrowSizes", m, (out) => out.fill(c.arrowSizes[0] ?? 0));
  const zeroRadii = memo.float32Into("loops.zeroRadii", c.halfArrow ? 2 * m : m, (out) => out.fill(0));
  const halfWidths = memo.float32Into("loops.halfWidths", c.halfArrow ? 2 * m : 0, (out) => {
    for (let i = 0; i < m; i++) {
      out[2 * i] = c.widths[list[i] ?? 0] ?? 0;
      out[2 * i + 1] = 0;
    }
  });
  const halfBends = memo.float32Into("loops.halfBends", c.halfArrow ? m : 0, (out) => {
    for (let i = 0; i < out.length; i++)
      out[i] = halfArrowLoopBend((targetOffsets[2 * i] ?? 0) - (sourceOffsets[2 * i] ?? 0), (targetOffsets[2 * i + 1] ?? 0) - (sourceOffsets[2 * i + 1] ?? 0));
  });
  const selected = linkSelected
    ? memo.uint8Into("loops.selected", m, (out) => {
        for (let i = 0; i < m; i++) out[i] = linkSelected[edges[i] ?? 0] ?? 0;
      })
    : undefined;
  selfLoopStats.instances += m;
  return {
    loops: { nodes: nodes.subarray(0, m), edges: edges.subarray(0, m), weights: weights.subarray(0, m), count: m },
    sizeMode: c.sizeMode,
    halfArrow: c.halfArrow,
    arrowheads: c.arrowheads,
    radii,
    widths,
    colors,
    groups,
    bends,
    arrowSizes,
    zeroRadii,
    halfWidths,
    centres,
    angles: angles.subarray(0, m),
    sourceOffsets,
    targetOffsets,
    halfBends: [halfBends, halfBends],
    halfBendSlot: 0,
    selected,
  };
}
