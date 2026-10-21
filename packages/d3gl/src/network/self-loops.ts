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
 *  its node to its neighbours, or {@link FALLBACK_ANGLE}. O(Σ degree of the looped nodes). */
export function selfLoopAngles(positions: ArrayLike<number>, csr: Adjacency, loops: SelfLoopIndex, out: Float32Array): Float32Array {
  for (let i = 0; i < loops.count; i++) {
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
    out[i] = Math.hypot(sx, sy) > 1e-9 ? Math.atan2(-sy, -sx) : FALLBACK_ANGLE;
  }
  return out;
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
 * The half-arrow lane's bend for a loop at angle `θ`. The half-arrow fixes its bow side by the chord's
 * direction (`positiveCurvature`, so a reciprocal pair nests) and multiplies by the bend's sign, where the line
 * lane bows by the sign alone. The loop's chord runs `θ + α → θ − α`, along `(sin θ, −cos θ)`, so the sign
 * that bows it outward flips with that rule.
 */
export function halfArrowLoopBend(theta: number): number {
  const dx = Math.sin(theta);
  const dy = -Math.cos(theta);
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
  /** `[0, S)`: every end offset is rewritten each position frame (#509 in-place range upload). */
  changed: Uint32Array;
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
 *  place. O(S + Σ degree of the looped nodes), no allocation. */
export function updateSelfLoops(graph: NetworkGraph, c: SelfLoopCache): void {
  const { loops, centres, angles } = c;
  const S = loops.count;
  const pos = graph.positions;
  for (let i = 0; i < S; i++) {
    const n = loops.nodes[i] ?? 0;
    centres[2 * i] = pos[2 * n] ?? 0;
    centres[2 * i + 1] = pos[2 * n + 1] ?? 0;
  }
  selfLoopAngles(pos, graph.csr, loops, angles);
  teardropEnds(loops, angles, c.radii, c.sourceOffsets, c.targetOffsets);
  if (c.halfArrow) {
    const cur = c.halfBends[c.halfBendSlot];
    const next = c.halfBends[c.halfBendSlot === 0 ? 1 : 0];
    let flipped = false;
    for (let i = 0; i < S; i++) {
      const b = halfArrowLoopBend(angles[i] ?? 0);
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
export function selfLoopLayers(c: SelfLoopCache): InstancedLayer[] {
  const { centres, sourceOffsets, targetOffsets, changed, sizeMode } = c;
  const count = c.loops.count;
  const ends = { sourceOffsets, targetOffsets, endOffsetsChanged: changed };
  if (c.halfArrow)
    return [
      {
        name: SELF_LOOP_LAYER,
        primitive: "half-arrows",
        sizeMode,
        halfArrows: { sources: centres, targets: centres, radii: c.zeroRadii, widths: c.halfWidths, bends: c.halfBends[c.halfBendSlot], colors: c.colors, samples: LOOP_SAMPLES, groups: c.groups, ...ends, count },
      },
    ];
  const layers: InstancedLayer[] = [
    { name: SELF_LOOP_LAYER, primitive: "lines", sizeMode, lines: { sources: centres, targets: centres, widths: c.widths, colors: c.colors, bends: c.bends, samples: LOOP_SAMPLES, groups: c.groups, ...ends, count } },
  ];
  if (c.arrowheads)
    layers.push({
      name: SELF_LOOP_ARROW_LAYER,
      primitive: "arrows",
      sizeMode,
      arrows: { sources: centres, targets: centres, radii: c.zeroRadii, sizes: c.arrowSizes, colors: c.colors, bends: c.bends, groups: c.groups, ...ends, count },
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
export function emitSelfLoops(g: GroupBuilder, c: SelfLoopCache): void {
  const { loops, centres, sourceOffsets: so, targetOffsets: to } = c;
  const screen = c.sizeMode === "screen";
  for (let i = 0; i < loops.count; i++) {
    const px = centres[2 * i] ?? 0;
    const py = centres[2 * i + 1] ?? 0;
    const sox = so[2 * i] ?? 0, soy = so[2 * i + 1] ?? 0, tox = to[2 * i] ?? 0, toy = to[2 * i + 1] ?? 0;
    g.drawable(loops.edges[i] ?? 0, (ctx) => traceTeardrop(ctx, px, py, sox, soy, tox, toy), { lineWidth: c.widths[i] ?? 0, anchor: screen ? [px, py] : undefined });
  }
}

/** The Scene twin of the `half-arrow` loops: one filled half-arrow glyph each, keyed by its edge. `bake` as
 *  `emitHalfLinks`: screen mode solves in px around the node centre × bake and emits ÷ bake. */
export function emitSelfLoopHalfArrows(g: GroupBuilder, c: SelfLoopCache, bake = 1): void {
  const { loops, centres, sourceOffsets: so, targetOffsets: to, angles } = c;
  for (let i = 0; i < loops.count; i++) {
    const px = (centres[2 * i] ?? 0) * bake;
    const py = (centres[2 * i + 1] ?? 0) * bake;
    const x0 = px + (so[2 * i] ?? 0), y0 = py + (so[2 * i + 1] ?? 0);
    const x1 = px + (to[2 * i] ?? 0), y1 = py + (to[2 * i + 1] ?? 0);
    const width = c.widths[i] ?? 0;
    const geom = halfLinkGeometry({ x0, y0, r0: 0, x1, y1, r1: 0, width, oppositeWidth: 0, bend: chordBend(x0, y0, x1, y1, halfArrowLoopBend(angles[i] ?? 0)) });
    if (!geom) continue;
    const out = bake === 1 ? geom : scaleHalfLink(geom, 1 / bake);
    g.drawable(loops.edges[i] ?? 0, (ctx) => traceHalfLink(out, ctx));
  }
}

/** The Scene twin of the loop arrowheads, in the `arrows` group (filled). `bake` as `emitArrows`: screen mode
 *  solves in px around the node centre × bake and emits ÷ bake (re-baked with the other arrowheads). */
export function emitSelfLoopArrows(g: GroupBuilder, c: SelfLoopCache, size: number, bake = 1): void {
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
    g.drawable(loops.edges[i] ?? 0, (ctx) => {
      ctx.moveTo(tipX * inv, tipY * inv);
      ctx.lineTo((baseX + uy * size) * inv, (baseY - ux * size) * inv);
      ctx.lineTo((baseX - uy * size) * inv, (baseY + ux * size) * inv);
      ctx.closePath();
    });
  }
}
