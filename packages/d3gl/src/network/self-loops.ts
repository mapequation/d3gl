/**
 * Self-link loops (#505): a link whose source and target are the same node has zero length, so the link
 * lanes draw nothing for it. This module turns a node's self-links into ONE small drop at its rim, sized from
 * the node's radius:
 *
 * - The loop ({@link ../core/loop-drop.ts}, #542) leaves the centre along `θ + α` and comes back along `θ − α` on
 *   the settled link cubic (`legCubic`), its far end round: a teardrop given by its two rim ends. On Canvas / SVG
 *   it is ONE shape in the `links` group: a stroked path (undirected), a filled arrow outline (directed `line`
 *   style, its tip on the rim) or a filled half-arrow outline. On WebGL it is the same ONE shape: one instance of
 *   the `loops` layer ({@link InstancedLoopsData}, its `head` the variant) with its two rim ends set off the node
 *   centre (#509), drawn by the line lane's loop program, so ordinary links run their program unchanged.
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
import type { InstancedLayer, InstancedLoopHead, InstancedLoopsData, GroupBuilder } from "../core/index.js";
import type { RGBAValue } from "./glyphs.js";
import type { StableColumns } from "../core/stable-columns.js";
import { DROP_HALF_SPREAD, loopPieceLength, spreadCot, traceLoop, traceLoopArrowOutline, traceLoopHalfArrowOutline } from "../core/loop-drop.js";

/** The direction of a loop whose node has no neighbours to point away from (radians, y down: up-right). */
export const FALLBACK_ANGLE = -Math.PI / 4;
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
  const start = csr.offsets[n] ?? 0;
  const end = csr.offsets[n + 1] ?? 0;
  selfLoopStats.neighbours += end - start;
  for (let k = start; k < end; k++) {
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
 *  on the rim at `θ + α` and `θ − α` (`α` = half the style's `selfLinkSpread`, radians). O(S). */
export function loopEnds(loops: SelfLoopIndex, angles: ArrayLike<number>, radii: ArrayLike<number>, sourceOffsets: Float32Array, targetOffsets: Float32Array, a = DROP_HALF_SPREAD): void {
  for (let i = 0; i < loops.count; i++) {
    const r = radii[loops.nodes[i] ?? 0] ?? 0;
    const t = angles[i] ?? 0;
    sourceOffsets[2 * i] = r * Math.cos(t + a);
    sourceOffsets[2 * i + 1] = r * Math.sin(t + a);
    targetOffsets[2 * i] = r * Math.cos(t - a);
    targetOffsets[2 * i + 1] = r * Math.sin(t - a);
  }
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
  /** The angle between a loop's two legs (degrees). */
  selfLinkSpread: number;
  /** A loop's leg length (node radii). */
  selfLinkLength: number;
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
  /** The `half-arrow` style (directed): one filled half-arrow outline per loop. */
  halfArrow: boolean;
  /** The directed `line` style: one filled arrow outline per loop, shaft and head as one shape (#542). */
  arrowheads: boolean;
  radii: Float32Array;
  // Style columns (per style version).
  widths: Float32Array;
  colors: Uint8Array;
  /** #162 highlight group per loop: its node (a loop is incident to its node at both ends). */
  groups: Float32Array;
  /** The leg `L` in node radii (`selfLinkLength`), one per style: the `loops` layer's `legLength`. */
  legLength: number;
  /** Half the angle between the legs, `α` (radians, half of `selfLinkSpread`): where {@link loopEnds} puts the ends. */
  halfSpread: number;
  /** `cot α`: the Scene writers recover each loop's centre from its ends with it (the `loops` layer takes `2α`). */
  spreadCot: number;
  /** The style's arrow size: with each loop's width, its straight pieces' length `loopPieceLength(arrowSize, width)`
   *  in every variant, and the arrow's head length `headLength(arrowSize)` (#542). */
  arrowSize: number;
  /** The `loops` layer's head (per style version): the variant and the arrow size. */
  head: InstancedLoopHead;
  // Position columns (rewritten in place each position frame).
  centres: Float32Array;
  angles: Float32Array;
  sourceOffsets: Float32Array;
  targetOffsets: Float32Array;
  /** `[0, S)`: every end offset is rewritten each position frame (#509 in-place range upload). Absent on an LOD
   *  frame's subset ({@link selfLoopSubset}), whose columns are handed back unchanged when their values are. */
  changed?: Uint32Array;
  /** Per-loop `selected` flags (#162), on an LOD frame's subset (the no-LOD lane attaches its own). */
  selected?: Uint8Array;
  /** LOD frames: the position version ({@link LoopSubsetFrame.positionsVersion}) each `angles` entry was solved at,
   *  0 for none, so a frame whose positions did not move (a zoom) copies its drawn loops' angles instead of
   *  re-reading their neighbours. 4 B per loop, built by the first LOD frame; {@link updateSelfLoops}, which rewrites
   *  `angles`, clears it. */
  angleAt?: Uint32Array;
  /** The node offsets (#509) the stamped angles were solved with: a frame with others solves them again. */
  angleOffsets?: Float32Array;
}

/** Instrumentation for the per-frame guards: loop updates run, loop instances they touched, and the neighbours the
 *  loop angles read (the Σ degree term). */
export const selfLoopStats = { updates: 0, instances: 0, neighbours: 0 };

/** The {@link SelfLoopCache} for `graph` under `style`, `null` without self-links. O(S) (+ the O(E) index once
 *  per graph). Leaves the position columns for {@link updateSelfLoops}. */
export function selfLoopCache(graph: NetworkGraph, style: SelfLoopStyle): SelfLoopCache | null {
  const loops = selfLoopIndex(graph);
  if (!loops) return null;
  const S = loops.count;
  const widths = new Float32Array(S);
  const colors = new Uint8Array(4 * S);
  for (let i = 0; i < S; i++) {
    const w = loops.weights[i] ?? 0;
    widths[i] = style.linkWidthOf(w);
    colors.set(style.linkColorOf(w), 4 * i);
  }
  const halfArrow = style.directed && style.linkStyle === "half-arrow";
  const halfSpread = (style.selfLinkSpread * Math.PI) / 360;
  return {
    loops,
    sizeMode: style.sizeMode,
    halfArrow,
    arrowheads: style.directed && !halfArrow,
    radii: style.nodeRadii,
    widths,
    colors,
    groups: Float32Array.from(loops.nodes),
    legLength: style.selfLinkLength,
    halfSpread,
    spreadCot: spreadCot(halfSpread),
    arrowSize: style.arrowSize,
    head: { head: halfArrow ? "half" : style.directed ? "arrow" : "none", arrowSize: style.arrowSize },
    centres: new Float32Array(2 * S),
    angles: new Float32Array(S),
    sourceOffsets: new Float32Array(2 * S),
    targetOffsets: new Float32Array(2 * S),
    changed: Uint32Array.of(0, S),
  };
}

/** The position frame: each loop's centre, angle and ends from `graph.positions`, in
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
  c.angleAt?.fill(0); // the LOD frames' stamps no longer describe `angles`
  loopEnds(loops, angles, c.radii, c.sourceOffsets, c.targetOffsets, c.halfSpread);
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
  selfLoopStats.updates++;
  selfLoopStats.instances += S;
}

/** The layer name the loops draw in (WebGL), between the links and the nodes. */
export const SELF_LOOP_LAYER = "self-loops";

/**
 * The instanced layer that draws the loops on WebGL, over the cache's current columns (call {@link updateSelfLoops}
 * first): ONE `loops` layer that draws each loop as the Scene's one shape (#542), its `head` the variant (`none`
 * undirected, `arrow` the line style's arrow, `half` the half-arrow), its `legLength` the leg `L`, its `spread` the legs'
 * angle `2α`. Instance `i` is loop `i`; its pick resolves to `loops.edges[i]`. O(1): no array is built.
 */
export function selfLoopLayers(c: SelfLoopCache, pickable?: true, pickBase?: number): InstancedLayer[] {
  const pick = pickBase === undefined ? {} : { pickable, pickBase };
  const loops: InstancedLoopsData = {
    ...c.head,
    centers: c.centres,
    startOffsets: c.sourceOffsets,
    endOffsets: c.targetOffsets,
    offsetsChanged: c.changed,
    widths: c.widths,
    colors: c.colors,
    legLength: c.legLength,
    spread: 2 * c.halfSpread,
    samples: LOOP_SAMPLES,
    groups: c.groups,
    selected: c.selected,
    count: c.loops.count,
  };
  return [{ name: SELF_LOOP_LAYER, primitive: "loops", sizeMode: c.sizeMode, ...pick, loops }];
}

/** Per-loop `selected` flags (#162) from the per-edge link flags: a loop is selected with its edge. O(S). */
export function selfLoopSelected(loops: SelfLoopIndex, linkSelected: Uint8Array): Uint8Array {
  const out = new Uint8Array(loops.count);
  for (let i = 0; i < loops.count; i++) out[i] = linkSelected[loops.edges[i] ?? 0] ?? 0;
  return out;
}

/**
 * The Scene twin (Canvas / SVG) of the undirected `line`-style loops: one stroked drawable each in the `links` group,
 * keyed by its edge ({@link traceLoop}, piece length `loopPieceLength(arrowSize, width)` so every variant runs the same path, leg
 * `legLength`).
 * World mode traces world geometry; screen mode traces px offsets around an `anchor` at the node centre, which the
 * Scene draws as `anchor′ + (p − anchor)`: constant px at every zoom, no re-bake. Reads the columns
 * {@link updateSelfLoops} wrote; each drawable captures its numbers, not the columns.
 */
export function emitSelfLoops(g: GroupBuilder, c: SelfLoopCache, idBase = 0): void {
  const { loops, centres, sourceOffsets: so, targetOffsets: to } = c;
  const screen = c.sizeMode === "screen";
  const cot = c.spreadCot;
  const leg = c.legLength;
  for (let i = 0; i < loops.count; i++) {
    const px = centres[2 * i] ?? 0;
    const py = centres[2 * i + 1] ?? 0;
    const sox = so[2 * i] ?? 0, soy = so[2 * i + 1] ?? 0, tox = to[2 * i] ?? 0, toy = to[2 * i + 1] ?? 0;
    const width = c.widths[i] ?? 0;
    const h = loopPieceLength(c.arrowSize, width);
    g.drawable(idBase + (loops.edges[i] ?? 0), (ctx) => traceLoop(ctx, px + sox, py + soy, px + tox, py + toy, h, leg, cot), { lineWidth: width, anchor: screen ? [px, py] : undefined });
  }
}

/** The Scene twin of the `half-arrow` loops: one filled half-arrow outline each ({@link traceLoopHalfArrowOutline}, its
 *  cubic edges as cubics the recorder flattens), keyed by its edge. `bake` as `emitHalfLinks`: screen mode solves in px
 *  around the node centre × bake and emits ÷ bake. Coincident ends (no loop) emit nothing. */
export function emitSelfLoopHalfArrows(g: GroupBuilder, c: SelfLoopCache, bake = 1, idBase = 0): void {
  const { loops, centres, sourceOffsets: so, targetOffsets: to } = c;
  const inv = 1 / bake;
  for (let i = 0; i < loops.count; i++) {
    const px = (centres[2 * i] ?? 0) * bake;
    const py = (centres[2 * i + 1] ?? 0) * bake;
    const sx = px + (so[2 * i] ?? 0), sy = py + (so[2 * i + 1] ?? 0), tx = px + (to[2 * i] ?? 0), ty = py + (to[2 * i + 1] ?? 0);
    if (sx === tx && sy === ty) continue;
    const width = c.widths[i] ?? 0;
    g.drawable(idBase + (loops.edges[i] ?? 0), (ctx) => traceLoopHalfArrowOutline(ctx, sx, sy, tx, ty, width, c.arrowSize, c.legLength, c.spreadCot, inv));
  }
}

/** The Scene twin of the directed `line`-style loops: one filled arrow outline each, shaft and head as ONE shape
 *  ({@link traceLoopArrowOutline}), keyed by its edge, in a filled group. `bake` as `emitArrowLinks`: screen mode solves
 *  in px around the node centre × bake and emits ÷ bake (re-baked with the links). Coincident ends emit nothing. */
export function emitSelfLoopArrows(g: GroupBuilder, c: SelfLoopCache, bake = 1, idBase = 0): void {
  const { loops, centres, sourceOffsets: so, targetOffsets: to } = c;
  const inv = 1 / bake;
  for (let i = 0; i < loops.count; i++) {
    const px = (centres[2 * i] ?? 0) * bake;
    const py = (centres[2 * i + 1] ?? 0) * bake;
    const sx = px + (so[2 * i] ?? 0), sy = py + (so[2 * i + 1] ?? 0), tx = px + (to[2 * i] ?? 0), ty = py + (to[2 * i + 1] ?? 0);
    if (sx === tx && sy === ty) continue;
    const width = c.widths[i] ?? 0;
    g.drawable(idBase + (loops.edges[i] ?? 0), (ctx) => traceLoopArrowOutline(ctx, sx, sy, tx, ty, width, c.arrowSize, c.legLength, c.spreadCot, inv));
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
  /** The engine's position version (≥ 1): it changes whenever positions may have moved, and a zoom keeps it. */
  positionsVersion: number;
}

/**
 * The loops `sc.list[0..m)` of `c` as a {@link SelfLoopCache} of their own (#505: an LOD frame's loops on kept
 * leaves), so {@link selfLoopLayers} and the Scene emitters draw it as they draw the whole set. Each loop's ends are
 * solved here, O(m); its angle is solved (O(degree of its node)) only when `frame.positionsVersion` moved since it was
 * last solved, else copied from `c.angles` (stamped per loop in `c.angleAt`): a zoom frame does no degree work. Its
 * style is copied from `c`. Every column goes through `memo` ({@link StableColumns}), so a frame whose loops and
 * positions did not change hands back the arrays the GPU holds and uploads nothing; memory: two arrays per column,
 * ≈ 2 × 37 B per drawn loop, reused.
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
  // The angle stamps: built once per cache (a style or graph change), cleared when the node offsets change.
  if (!c.angleAt) c.angleAt = new Uint32Array(loops.count);
  if (c.angleOffsets !== off) {
    c.angleAt.fill(0);
    c.angleOffsets = off;
  }
  const at = c.angleAt;
  const ver = frame.positionsVersion;
  for (let i = 0; i < m; i++) {
    const j = list[i] ?? 0;
    const n = loops.nodes[j] ?? 0;
    nodes[i] = n;
    edges[i] = loops.edges[j] ?? 0;
    weights[i] = loops.weights[j] ?? 0;
    if (at[j] !== ver) {
      c.angles[j] = selfLoopAngle(graph.positions, graph.csr, n, off);
      at[j] = ver;
    }
    angles[i] = c.angles[j] ?? 0;
  }
  const { cx, cy, fade, linkSelected } = frame;
  const a = c.halfSpread;
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
    legLength: c.legLength,
    halfSpread: c.halfSpread,
    spreadCot: c.spreadCot,
    arrowSize: c.arrowSize,
    head: c.head,
    centres,
    angles: angles.subarray(0, m),
    sourceOffsets,
    targetOffsets,
    selected,
  };
}
