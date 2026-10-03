/**
 * The per-frame LOD step of a streaming layout (#343) — DOM-free and pure, so a layout worker's frame loop
 * is only glue around it.
 *
 * Whatever tree the cut draws, a streamed frame asks the same question: given the positions of this frame,
 * what LOD geometry goes with them? {@link lodFrameStep} answers it for both trees:
 *
 * - **structure** (the coarsening tree): its topology is position-independent and already on the main
 *   thread, so the step **refits** the geometry in place (`cx`/`cy`/`extent` in the buffer the main thread
 *   reads — shared, or posted with the frame) and returns nothing to send.
 * - **spatial** (the Morton tree): a tree built from older positions blows the frontier up as members
 *   wander out of their cells, so the step **rebuilds** it — topology, geometry and the aggregated style —
 *   into one packed buffer ({@link SpatialLODFrame}) to transfer, and, for a stream that knows the graph's
 *   edges, draws links and has been told the main thread's view ({@link LODView}), the **super-edge rows** of
 *   the glyphs that view's cut and declutter keep into a second one (#433, `spatial-rows.ts`) — so the main
 *   thread reads a streamed tree's links from rows bounded by what it draws instead of walking every edge
 *   under the frontier. Buffers come back
 *   from the main thread for reuse ({@link recycleSpatialFrame}), so a warm stream allocates nothing. It
 *   rebuilds only for new positions (a frame id it has not built), so it stops once the layout has converged.
 *
 * The worker backend's frame loop calls it for every frame it posts, and a GPU layout's LOD worker (#377) for
 * every position snapshot the GPU harvests (`answerLODGeometry` in `lod-refit.ts`): it binds the geometry
 * buffer the request handed back to a structure stream's tree first, and posts a spatial stream's frame with
 * its transfer list. Returned buffers go to {@link recycleSpatialFrame}; the worker backend re-runs the step
 * when it says a skipped frame is due, while the GPU relay never lets one be skipped (it takes no harvest
 * while {@link MAX_OUTSTANDING} trees are out, and its worker keeps no positions to build one from later).
 */
import {
  buildMortonTopology,
  computeLODCrowding,
  computeLODPositions,
  computeLODStyle,
  cut,
  declutterFrontier,
  crowdingHorizon,
  lodTreeFromTopology,
  makeCutScratch,
  makeDeclutterFrontierScratch,
  makeLODBoundsScratch,
  makeLODCrowdingScratch,
  makeMortonScratch,
  mortonRootBox,
  type CutScratch,
  type DeclutterFrontierScratch,
  type LODBoundsScratch,
  type LODCrowdingScratch,
  type LODPositionTree,
  type LODTree,
  type MortonBox,
  type MortonScratch,
  type MortonTopologyArrays,
  type MortonTopologySizes,
} from "./lod.js";
import { layoutBox, layoutFitTransform, type FitBox } from "./fit.js";
import {
  buildKeptRows,
  makeSpatialRowsScratch,
  spatialRowsByteLength,
  spatialRowsGraph,
  spatialRowsViews,
  type SpatialRowsFrame,
  type SpatialRowsGraph,
  type SpatialRowsScratch,
} from "./spatial-rows.js";

/**
 * What a tree's crowding reads of the leaf style (#426) — all a structure stream is given: the leaves' draw
 * radii and how they are sized.
 */
export interface LeafSizing {
  radii: Float32Array;
  /**
   * How the glyphs are sized, and the cut's explicit threshold, for the tree's crowding (#426): with it,
   * every tree a stream rebuilds or refits carries its {@link LODTree.clearZoom} (see
   * {@link computeLODCrowding}); without it, none (`Infinity`: only the footprint rule opens a node).
   */
  crowding?: LeafCrowding;
}

/**
 * The per-leaf style a spatial stream aggregates onto every rebuilt tree (#343) — the inputs of
 * {@link computeLODStyle}: draw radii, declutter importance, and optionally the flow-border metric and
 * RGBA colours — plus the sizing its crowding reads. A spatial aggregate is sized area-additively (√Σr²): a
 * cell is a region of the layout, not a unit of the sizing metric, so the leaf scale is never applied to
 * summed values here.
 */
export interface LeafStyle extends LeafSizing {
  weight: Float32Array;
  border?: Float32Array;
  colors?: Uint8Array;
  /** Whether links are drawn (#433): a stream that knows the edges builds super-edge rows only then.
   *  Default true. */
  links?: boolean;
}

/** The glyph sizing and cut threshold a stream computes a tree's crowding with (#426). */
export interface LeafCrowding {
  /** Glyph radii are screen px (`sizeMode: "screen"`); else world units. */
  screenSized: boolean;
  /** The cut's explicit `expandPx`, or undefined for the tree-adaptive default ({@link crowdingHorizon}). */
  expandPx?: number;
  /** The overlap test's radius factor (`lod({ overlapSpacing })`, {@link CrowdingOptions.spacing}); default 1. */
  spacing?: number;
}

/** A packed spatial frame's shape: what {@link spatialFrameViews} needs to read it. */
export interface SpatialFrameHeader {
  size: number;
  leafCount: number;
  levelCount: number;
  /** {@link LODTree.leafBranching}, computed where the tree was built. */
  leafBranching: number;
  box: MortonBox;
  /** The style version the tree's style arrays were aggregated with (−1: none — zeroed). */
  styleVersion: number;
  /** The frame id it was built for (the worker's tick). */
  frame: number;
  /** Whether `clearZoom` holds the tree's crowding (#426): only a settled frame's does; a streamed frame's is
   *  `Infinity` (the footprint rule alone), and the engine computes the crowding once the layout settles. */
  crowding: boolean;
  /**
   * The layout box of the frame's positions its super-edge rows were cut at, when the view followed the fit
   * (#433: `layoutBox` without stragglers). The engine frames this box while it follows the fit, so it cuts
   * the tree where the rows were cut — in shared mode the live positions are newer than the tree by the time
   * it repaints. Absent when the rows were cut at a transform, or there are none.
   */
  fitBox?: FitBox;
}

/**
 * One rebuilt spatial tree (#343): topology, position geometry, aggregated style and crowding (#426), packed
 * into one transferable `buffer` (see {@link spatialFrameViews}). About 60 B per tree node plus 4 B per leaf —
 * 26 MB for a 325k-node graph — moved, not copied, between the threads. With `rows`, the tree's super-edge
 * rows (#433) in a second transferable buffer.
 */
export interface SpatialLODFrame {
  header: SpatialFrameHeader;
  buffer: ArrayBuffer;
  rows?: SpatialRowsFrame;
}

/** Every array of a packed spatial frame, as views into its buffer. */
export interface SpatialFrameArrays extends MortonTopologyArrays {
  cx: Float32Array;
  cy: Float32Array;
  extent: Float32Array;
  clearZoom: Float32Array;
  count: Uint32Array;
  radius: Float32Array;
  weight: Float32Array;
  border: Float32Array;
  color: Uint8Array;
}

/** Bytes a packed spatial frame of these sizes needs: the 4-byte arrays first, then the byte arrays. */
export function spatialFrameByteLength({ size, leafCount, levelCount }: MortonTopologySizes): number {
  const cells = size - leafCount;
  const words = levelCount + 1 + (size + 1) + Math.max(0, size - 1) + 3 * size + leafCount + cells + 5 * size + 3 * size;
  return 4 * words + 4 * size + cells;
}

/**
 * The arrays of a packed spatial frame, viewed in `buffer` — the one layout the writer (the worker) and the
 * reader (the main thread) share. O(1): views only.
 */
export function spatialFrameViews(buffer: ArrayBufferLike, { size, leafCount, levelCount }: MortonTopologySizes): SpatialFrameArrays {
  const cells = size - leafCount;
  let at = 0;
  const u32 = (n: number): Uint32Array => { const v = new Uint32Array(buffer, at, n); at += 4 * n; return v; };
  const i32 = (n: number): Int32Array => { const v = new Int32Array(buffer, at, n); at += 4 * n; return v; };
  const f32 = (n: number): Float32Array => { const v = new Float32Array(buffer, at, n); at += 4 * n; return v; };
  const u8 = (n: number): Uint8Array => { const v = new Uint8Array(buffer, at, n); at += n; return v; };
  return {
    levelOffset: u32(levelCount + 1),
    childOffset: u32(size + 1),
    children: u32(Math.max(0, size - 1)),
    parent: i32(size),
    leafOrder: u32(leafCount),
    leafStart: u32(size),
    leafEnd: u32(size),
    mortonCode: u32(cells),
    cx: f32(size),
    cy: f32(size),
    extent: f32(size),
    clearZoom: f32(size),
    count: u32(size),
    radius: f32(size),
    weight: f32(size),
    border: f32(size),
    color: u8(4 * size),
    mortonLevel: u8(cells),
  };
}

/**
 * The {@link LODTree} a packed spatial frame holds, its arrays viewing the frame's buffer — O(1), nothing
 * copied or recomputed (count, leaf branching and style came computed). The tree is valid until the buffer
 * is handed back ({@link recycleSpatialFrame}) — after that its views are detached.
 */
export function lodTreeFromSpatialFrame(frame: SpatialLODFrame): LODTree {
  const { header, buffer, rows } = frame;
  const v = spatialFrameViews(buffer, header);
  const topo = {
    size: header.size,
    leafCount: header.leafCount,
    levelCount: header.levelCount,
    levelOffset: v.levelOffset,
    childOffset: v.childOffset,
    children: v.children,
    parent: v.parent,
    leafOrder: v.leafOrder,
    leafStart: v.leafStart,
    leafEnd: v.leafEnd,
    morton: { box: header.box, level: v.mortonLevel, code: v.mortonCode },
    rows: rows ? spatialRowsViews(rows.buffer, rows.sizes) : undefined,
  };
  return lodTreeFromTopology(
    // The empty same-level adjacency every spatial tree shares (see buildMortonTopology).
    { ...topo, edgeOffset: emptyAdjacency(header.size), edgeNeighbors: NO_NEIGHBORS },
    { cx: v.cx, cy: v.cy, extent: v.extent, clearZoom: v.clearZoom },
    { count: v.count, radius: v.radius, weight: v.weight, border: v.border, color: v.color, leafBranching: header.leafBranching },
  );
}

let zeroAdjacency = new Uint32Array(0);
/** A shared all-zero offsets array of `size + 1` (a CSR with no entries); nothing writes to it. */
function emptyAdjacency(size: number): Uint32Array {
  if (zeroAdjacency.length < size + 1) zeroAdjacency = new Uint32Array(Math.max(size + 1, zeroAdjacency.length * 2));
  return zeroAdjacency.subarray(0, size + 1);
}
const NO_NEIGHBORS = new Uint32Array(0);

/** What a structure stream refits per frame: the position geometry, and the crowding (#426) from its leaf radii. */
export type StructureStreamTree = LODPositionTree & Pick<LODTree, "radius" | "clearZoom" | "leafBranching">;

/** A coarsening tree's per-frame state: the worker's tree (geometry and crowding bound to the frame buffer). */
export interface StructureLODStream {
  kind: "structure";
  tree: StructureStreamTree;
  bounds: LODBoundsScratch;
  /** The leaf sizing its crowding is computed with (#426), or null for none (`clearZoom` stays `Infinity`). */
  style: LeafSizing | null;
  /** The sizing whose radii the tree's leaves hold (copied once per sizing, not per frame). */
  radiiOf: LeafSizing | null;
  crowding: LODCrowdingScratch;
}

/**
 * The view a spatial stream builds super-edge rows for (#433): what the main thread's LOD cut and declutter
 * are called with — so the worker cuts and declutters each rebuilt tree the same way and builds the rows of
 * exactly the glyphs it will keep. `transform: null` while the camera follows the streaming layout's fit,
 * which the worker computes from the frame's positions as the engine does (`layoutBox` without stragglers →
 * `layoutFitTransform` padded by `fitPad`). A view that has moved on only costs speed: the main thread sums
 * the row of a kept glyph the rows cannot serve from its leaves, as the lazy gather does.
 */
export interface LODView {
  transform: { k: number; x: number; y: number } | null;
  /** The drawn leaf radius the fit keeps inside the frame (world units, or screen pixels when screen-sized). */
  fitPad: number;
  width: number;
  height: number;
  expandPx?: number;
  maxAggregateRadius?: number;
  screenSized: boolean;
  fadeBand: number;
  /** Whether the engine declutters its frontier, and with what spacing (`lod({ declutter, declutterSpacing })`). */
  declutter: boolean;
  declutterSpacing?: number;
}

/**
 * What a spatial stream needs to build each tree's super-edge rows (#433): the graph's CSR with each
 * entry's weight and direction (built once per stream: 4 B per CSR entry, 1 B for its direction, 4 B for its
 * weight unless every edge weighs the same — 10-18 B per edge — plus 4 B per node), the cut, declutter and
 * build scratch (4 B per leaf and 4 B per tree node, the rest per glyph), and the pool of returned rows buffers.
 */
export interface SpatialLinks {
  graph: SpatialRowsGraph;
  scratch: SpatialRowsScratch;
  cut: CutScratch;
  declutter: DeclutterFrontierScratch;
  /** The cut's cross-fade alphas in a band (indexed by tree node), which the declutter reads. */
  fade: Float32Array;
  pool: ArrayBuffer[];
}

/** A spatial tree's per-frame state: the root box it keeps stable, scratch, leaf style and buffer pool. */
export interface SpatialLODStream {
  kind: "spatial";
  leafCount: number;
  box: MortonBox | undefined;
  scratch: MortonScratch;
  bounds: LODBoundsScratch;
  crowding: LODCrowdingScratch;
  style: LeafStyle | null;
  styleVersion: number;
  /** Buffers the main thread handed back, reused before allocating. */
  pool: ArrayBuffer[];
  /** The frame id last built for (−1: none), so unchanged positions are not rebuilt. */
  built: number;
  /** Whether the frame last built carried the crowding (a settled frame): a settled step rebuilds one that did not. */
  builtCrowding: boolean;
  /** Frames built and not handed back yet ({@link recycleSpatialFrame}): posted, queued or still drawn. */
  outstanding: number;
  /** Whether a frame was skipped for back-pressure ({@link MAX_OUTSTANDING}) and is still to be built. */
  pending: boolean;
  /** The graph's edges for the super-edge rows (#433), or `null`: frames then carry no rows. */
  links: SpatialLinks | null;
  /** The main thread's view the rows are built for (#433), or `null` (none reported): no rows. */
  view: LODView | null;
}

export type LODStream = StructureLODStream | SpatialLODStream;

/**
 * A structure stream refitting `tree` (its `cx`/`cy`/`extent`/`clearZoom` bound to the buffer the main thread
 * reads), with the crowding of `sizing` (#426) when given.
 */
export function makeStructureLODStream(tree: StructureStreamTree, sizing?: LeafSizing): StructureLODStream {
  return { kind: "structure", tree, bounds: makeLODBoundsScratch(), style: sizing ?? null, radiiOf: null, crowding: makeLODCrowdingScratch() };
}

/** The directed edges a spatial stream builds super-edge rows from (#433): the layout's own edge list. */
export interface SpatialEdges {
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
}

/**
 * A spatial stream over `leafCount` leaves, aggregating `style` (version `styleVersion`) when given. With
 * `edges` (and a graph that has any) and a `view`, every rebuilt tree also carries the super-edge rows of the
 * covers that view draws (#433) while the style draws links; the stream builds the edges' CSR once, here
 * (O(edges)). The view follows the main thread's ({@link LODView}; set `stream.view` when it changes).
 */
export function makeSpatialLODStream(leafCount: number, style?: LeafStyle, styleVersion = -1, edges?: SpatialEdges, view?: LODView): SpatialLODStream {
  let links: SpatialLinks | null = null;
  if (edges && edges.source.length > 0) {
    links = { graph: spatialRowsGraph(leafCount, edges), scratch: makeSpatialRowsScratch(), cut: makeCutScratch(), declutter: makeDeclutterFrontierScratch(), fade: new Float32Array(0), pool: [] };
  }
  return { kind: "spatial", leafCount, box: undefined, scratch: makeMortonScratch(), bounds: makeLODBoundsScratch(), crowding: makeLODCrowdingScratch(), style: style ?? null, styleVersion: style ? styleVersion : -1, pool: [], built: -1, builtCrowding: false, outstanding: 0, pending: false, links, view: view ?? null };
}

/** Give a spatial stream a new leaf style (#343, #426): later frames aggregate it and compute the crowding with it. */
export function setStreamStyle(stream: SpatialLODStream, style: LeafStyle, version: number): void {
  stream.style = style;
  stream.styleVersion = version;
}

/** Give a structure stream a new leaf sizing (#426): later frames compute the crowding with it. */
export function setStreamSizing(stream: StructureLODStream, sizing: LeafSizing): void {
  stream.style = sizing;
}

/** Pooled buffers kept at most (a streamed frame is usually 1-2 in flight). */
const POOL_MAX = 3;

/**
 * Frames a spatial stream lets be outstanding at once (#343) — built and not handed back: the one the main
 * thread draws, the one it just replaced (released after the repaint), and one on its way. Past that the
 * main thread is not keeping up (a long task, a stalled tab), so {@link lodFrameStep} skips the rebuild
 * rather than allocating another frame buffer, and builds the latest positions once one comes back. Frame
 * buffers (and rows buffers, #433) in existence per stream are therefore at most this many plus
 * {@link POOL_MAX} each.
 */
export const MAX_OUTSTANDING = 3;

/**
 * Hand a frame's buffer — and its rows buffer (#433), when it carried one — back to its stream for the next
 * rebuild. Returns whether a frame skipped for back-pressure is now due: the caller then runs
 * {@link lodFrameStep} again for the current positions.
 */
export function recycleSpatialFrame(stream: SpatialLODStream, buffer: ArrayBuffer, rows?: ArrayBuffer): boolean {
  if (stream.outstanding > 0) stream.outstanding--;
  if (stream.pool.length < POOL_MAX && buffer.byteLength > 0) stream.pool.push(buffer);
  const links = stream.links;
  if (rows && links && links.pool.length < POOL_MAX && rows.byteLength > 0) links.pool.push(rows);
  return stream.pending && stream.outstanding < MAX_OUTSTANDING;
}

/**
 * A buffer of `pool` that fits `bytes` — at least `bytes` and at most twice it — or a fresh one with 1/8 slack.
 * Pooled buffers that do not fit are dropped, not kept: a stream whose sizes moved on (a zoom-in shrinks the rows,
 * a layout spreading out grows the tree) would otherwise hold them for the rest of the stream and allocate on
 * every frame once they fill the pool. So the pool only ever keeps buffers the next frame can take. O(POOL_MAX).
 */
function takeBuffer(pool: ArrayBuffer[], bytes: number): ArrayBuffer {
  let taken: ArrayBuffer | undefined;
  let kept = 0;
  for (const b of pool) {
    if (b.byteLength < bytes || b.byteLength > 2 * bytes) continue; // dropped
    if (taken) pool[kept++] = b;
    else taken = b;
  }
  pool.length = kept;
  return taken ?? new ArrayBuffer(Math.ceil((bytes * 9) / 8 / 8) * 8);
}

/**
 * **The per-frame LOD step** (#343): rebuild if spatial, else refit. For a structure stream, refits its tree's
 * position geometry to `positions` in place and returns `null`. For a spatial stream, rebuilds the Morton tree
 * over `positions` (in the stream's stable root box), refits it, aggregates the stream's leaf style onto it,
 * and returns the packed frame to transfer — or `null` when `frame` was already built (the layout has not moved
 * since: converged), or when {@link MAX_OUTSTANDING} frames are still out (back-pressure: the stream marks
 * itself `pending`, and {@link recycleSpatialFrame} says when to call again). O(tree size) either way; the
 * rebuild adds the O(leaves) sort and O(cells) splits.
 *
 * The crowding (#426) is computed only for a `settled` frame — the layout's `done` — when the stream has a style
 * with {@link LeafStyle.crowding}; a streamed frame's `clearZoom` is `Infinity`, so while a layout streams the
 * cut opens aggregates by the footprint rule alone (the crowding pass costs 0.35-1 s per frame at 2M nodes). A
 * settled step rebuilds a spatial frame already built for `frame` without the crowding. The crowding adds the
 * cross pairs near sibling borders (see {@link computeLODCrowding}).
 */
export function lodFrameStep(stream: LODStream, positions: ArrayLike<number>, frame: number, settled = false): SpatialLODFrame | null {
  if (stream.kind === "structure") {
    const tree = stream.tree;
    computeLODPositions(tree, positions, undefined, stream.bounds);
    const crowd = stream.style?.crowding;
    if (settled && stream.style && crowd) {
      // The crowding reads the leaves' radii off the tree: copy them in once per sizing.
      if (stream.radiiOf !== stream.style) {
        tree.radius.set(stream.style.radii.subarray(0, tree.leafCount));
        stream.radiiOf = stream.style;
      }
      computeLODCrowding(tree, { screenSized: crowd.screenSized, expandPx: crowdingHorizon(tree, crowd.expandPx), spacing: crowd.spacing }, stream.crowding);
    } else tree.clearZoom.fill(Infinity); // streamed: the footprint rule alone
    return null;
  }
  if (frame === stream.built && (stream.builtCrowding || !settled)) return null;
  if (stream.outstanding >= MAX_OUTSTANDING) {
    stream.pending = true; // built once a buffer comes back (see recycleSpatialFrame)
    return null;
  }
  stream.built = frame;
  const crowding = settled && !!stream.style?.crowding;
  stream.builtCrowding = crowding;
  stream.pending = false;
  stream.outstanding++;
  const n = stream.leafCount;
  const box = mortonRootBox(positions, n, stream.box);
  stream.box = box;
  // The topology is written straight into the frame buffer, sized once the cell count is known.
  const out: { buffer: ArrayBuffer | null; views: SpatialFrameArrays | null } = { buffer: null, views: null };
  const topology = buildMortonTopology(positions, n, { box }, stream.scratch, (sizes) => {
    const buffer = takeBuffer(stream.pool, spatialFrameByteLength(sizes));
    const views = spatialFrameViews(buffer, sizes);
    out.buffer = buffer;
    out.views = views;
    return views;
  });
  const { buffer, views } = out;
  if (!buffer || !views) throw new Error("lodFrameStep: the spatial tree was built without its frame buffer");
  const tree = lodTreeFromTopology(topology, { cx: views.cx, cy: views.cy, extent: views.extent, clearZoom: views.clearZoom }, {
    count: views.count,
    radius: views.radius,
    weight: views.weight,
    border: views.border,
    color: views.color,
  });
  computeLODPositions(tree, positions, undefined, stream.bounds);
  const style = stream.style;
  if (style) computeLODStyle(tree, style.radii, style.weight, style.border, style.colors);
  else {
    views.radius.fill(0);
    views.weight.fill(0);
    views.border.fill(0);
  }
  if (!style?.colors) views.color.fill(0); // a reused buffer holds the last frame's colours
  if (crowding && style?.crowding) computeLODCrowding(tree, { screenSized: style.crowding.screenSized, expandPx: crowdingHorizon(tree, style.crowding.expandPx), spacing: style.crowding.spacing }, stream.crowding);
  else views.clearZoom.fill(Infinity); // streamed, or no sizing: the footprint rule alone (a reused buffer holds the last frame's)
  // The super-edge rows of the glyphs the main thread's view will keep (#433), into a pooled buffer.
  const links = stream.links;
  const cover = links && stream.view && style?.links !== false ? keptRows(tree, positions, stream.view, links) : undefined;
  const header: SpatialFrameHeader = {
    size: topology.size,
    leafCount: n,
    levelCount: topology.levelCount,
    leafBranching: tree.leafBranching,
    box,
    styleVersion: style ? stream.styleVersion : -1,
    frame,
    crowding,
  };
  if (cover?.fitBox) header.fitBox = cover.fitBox;
  return { header, buffer, rows: cover?.rows };
}

/**
 * The super-edge rows of the glyphs `view`'s cut and declutter keep on `tree` (#433): the engine's cut, at the
 * view's transform — or, while it follows the fit, at the fit the engine frames `positions` at (returned as
 * `fitBox`, for the frame's header) — with the culled roots recorded, then the engine's declutter; the kept
 * cells get a row. O(drawn + culled) for the cut and O(drawn log drawn) for the declutter (+ O(leaves) for the
 * fit's box), then {@link buildKeptRows}: O(leaves + edges under the kept cells).
 */
function keptRows(tree: LODTree, positions: ArrayLike<number>, view: LODView, links: SpatialLinks): { rows: SpatialRowsFrame; fitBox: FitBox | null } | undefined {
  const { leafOrder, leafStart, leafEnd } = tree;
  if (!leafOrder || !leafStart || !leafEnd) return undefined;
  let t = view.transform;
  let fitBox: FitBox | null = null;
  if (!t) {
    fitBox = layoutBox(positions, tree.leafCount, { trimStragglers: true });
    if (!fitBox) return undefined;
    t = layoutFitTransform(fitBox, view.width, view.height, view.fitPad, view.screenSized);
  }
  let fadeAlpha: Float32Array | undefined;
  if (view.fadeBand > 0) {
    if (links.fade.length < tree.size) links.fade = new Float32Array(Math.max(tree.size, 2 * links.fade.length));
    fadeAlpha = links.fade;
  }
  const sc = links.cut;
  const drawn = cut(tree, t, view.width, view.height, {
    expandPx: view.expandPx,
    screenSized: view.screenSized,
    maxAggregateRadius: view.maxAggregateRadius,
    fadeBand: view.fadeBand,
    fadeAlpha,
    recordCulled: true,
  }, sc);
  const kept = view.declutter
    ? declutterFrontier(tree, drawn, t, view.width, view.height, {
      screenSized: view.screenSized,
      k: t.k,
      maxAggregateRadius: view.maxAggregateRadius,
      spacing: view.declutterSpacing,
      fadeAlpha,
    }, links.declutter)
    : drawn;
  const cutSet = { drawn, kept, culled: sc.culled.subarray(0, sc.culledCount), split: sc.split.subarray(0, sc.splitCount) };
  const out: { buffer: ArrayBuffer | null } = { buffer: null };
  const topo = { size: tree.size, leafCount: tree.leafCount, leafOrder, leafStart, leafEnd };
  const sizes = buildKeptRows(topo, cutSet, links.graph, links.scratch, (s) => {
    const b = takeBuffer(links.pool, spatialRowsByteLength(s));
    out.buffer = b;
    return spatialRowsViews(b, s);
  });
  if (!out.buffer) throw new Error("lodFrameStep: the super-edge rows were built without their buffer");
  return { rows: { sizes, buffer: out.buffer }, fitBox };
}
