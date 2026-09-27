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
 *   into one packed buffer ({@link SpatialLODFrame}) to transfer. Buffers come back from the main thread for
 *   reuse ({@link recycleSpatialFrame}), so a warm stream allocates nothing. It rebuilds only for new
 *   positions (a frame id it has not built), so it stops once the layout has converged.
 *
 * The worker backend's frame loop calls it for every frame it posts. A GPU layout's LOD worker (#377) can
 * call the same function for every position snapshot it harvests: bind the geometry buffer the request
 * handed back to a structure stream's tree first (as its refit does), and post a spatial stream's frame
 * with its transfer list.
 */
import {
  buildMortonTopology,
  computeLODPositions,
  computeLODStyle,
  lodTreeFromTopology,
  makeLODBoundsScratch,
  makeMortonScratch,
  mortonRootBox,
  type LODBoundsScratch,
  type LODPositionTree,
  type LODTree,
  type MortonBox,
  type MortonScratch,
  type MortonTopologyArrays,
  type MortonTopologySizes,
} from "./lod.js";

/**
 * The per-leaf style a spatial stream aggregates onto every rebuilt tree (#343) — the inputs of
 * {@link computeLODStyle}: draw radii, declutter importance, and optionally the flow-border metric and
 * RGBA colours. A spatial aggregate is sized area-additively (√Σr²): a cell is a region of the layout, not
 * a unit of the sizing metric, so the leaf scale is never applied to summed values here.
 */
export interface LeafStyle {
  radii: Float32Array;
  weight: Float32Array;
  border?: Float32Array;
  colors?: Uint8Array;
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
}

/**
 * One rebuilt spatial tree (#343): topology, position geometry and aggregated style, packed into one
 * transferable `buffer` (see {@link spatialFrameViews}). About 56 B per tree node plus 4 B per leaf —
 * 24 MB for a 325k-node graph — moved, not copied, between the threads.
 */
export interface SpatialLODFrame {
  header: SpatialFrameHeader;
  buffer: ArrayBuffer;
}

/** Every array of a packed spatial frame, as views into its buffer. */
export interface SpatialFrameArrays extends MortonTopologyArrays {
  cx: Float32Array;
  cy: Float32Array;
  extent: Float32Array;
  count: Uint32Array;
  radius: Float32Array;
  weight: Float32Array;
  border: Float32Array;
  color: Uint8Array;
}

/** Bytes a packed spatial frame of these sizes needs: the 4-byte arrays first, then the byte arrays. */
export function spatialFrameByteLength({ size, leafCount, levelCount }: MortonTopologySizes): number {
  const cells = size - leafCount;
  const words = levelCount + 1 + (size + 1) + Math.max(0, size - 1) + 3 * size + leafCount + cells + 4 * size + 3 * size;
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
  const { header, buffer } = frame;
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
  };
  return lodTreeFromTopology(
    // The empty same-level adjacency every spatial tree shares (see buildMortonTopology).
    { ...topo, edgeOffset: emptyAdjacency(header.size), edgeNeighbors: NO_NEIGHBORS },
    { cx: v.cx, cy: v.cy, extent: v.extent },
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

/** A coarsening tree's per-frame state: the worker's position tree (geometry bound to the frame buffer). */
export interface StructureLODStream {
  kind: "structure";
  tree: LODPositionTree;
  bounds: LODBoundsScratch;
}

/** A spatial tree's per-frame state: the root box it keeps stable, scratch, leaf style and buffer pool. */
export interface SpatialLODStream {
  kind: "spatial";
  leafCount: number;
  box: MortonBox | undefined;
  scratch: MortonScratch;
  bounds: LODBoundsScratch;
  style: LeafStyle | null;
  styleVersion: number;
  /** Buffers the main thread handed back, reused before allocating. */
  pool: ArrayBuffer[];
  /** The frame id last built for (−1: none), so unchanged positions are not rebuilt. */
  built: number;
}

export type LODStream = StructureLODStream | SpatialLODStream;

/** A structure stream refitting `tree` (its `cx`/`cy`/`extent` bound to the buffer the main thread reads). */
export function makeStructureLODStream(tree: LODPositionTree): StructureLODStream {
  return { kind: "structure", tree, bounds: makeLODBoundsScratch() };
}

/** A spatial stream over `leafCount` leaves, aggregating `style` (version `styleVersion`) when given. */
export function makeSpatialLODStream(leafCount: number, style?: LeafStyle, styleVersion = -1): SpatialLODStream {
  return { kind: "spatial", leafCount, box: undefined, scratch: makeMortonScratch(), bounds: makeLODBoundsScratch(), style: style ?? null, styleVersion: style ? styleVersion : -1, pool: [], built: -1 };
}

/** Pooled buffers kept at most (a streamed frame is usually 1-2 in flight). */
const POOL_MAX = 3;

/** Hand a frame's buffer back to its stream for the next rebuild. */
export function recycleSpatialFrame(stream: SpatialLODStream, buffer: ArrayBuffer): void {
  if (stream.pool.length < POOL_MAX && buffer.byteLength > 0) stream.pool.push(buffer);
}

/** A pooled buffer of at least `bytes` (and not more than twice it), or a fresh one with 1/8 slack. */
function takeBuffer(stream: SpatialLODStream, bytes: number): ArrayBuffer {
  for (let i = 0; i < stream.pool.length; i++) {
    const b = stream.pool[i]!;
    if (b.byteLength >= bytes && b.byteLength <= 2 * bytes) {
      stream.pool.splice(i, 1);
      return b;
    }
  }
  return new ArrayBuffer(Math.ceil((bytes * 9) / 8 / 8) * 8);
}

/**
 * **The per-frame LOD step** (#343): rebuild if spatial, else refit. For a structure stream, refits its tree's
 * position geometry to `positions` in place and returns `null`. For a spatial stream, rebuilds the Morton tree
 * over `positions` (in the stream's stable root box), refits it, aggregates the stream's leaf style onto it,
 * and returns the packed frame to transfer — or `null` when `frame` was already built (the layout has not
 * moved since: converged). O(tree size) either way; the rebuild adds the O(leaves) sort and O(cells) splits.
 */
export function lodFrameStep(stream: LODStream, positions: ArrayLike<number>, frame: number): SpatialLODFrame | null {
  if (stream.kind === "structure") {
    computeLODPositions(stream.tree, positions, undefined, stream.bounds);
    return null;
  }
  if (frame === stream.built) return null;
  stream.built = frame;
  const n = stream.leafCount;
  const box = mortonRootBox(positions, n, stream.box);
  stream.box = box;
  // The topology is written straight into the frame buffer, sized once the cell count is known.
  const out: { buffer: ArrayBuffer | null; views: SpatialFrameArrays | null } = { buffer: null, views: null };
  const topology = buildMortonTopology(positions, n, { box }, stream.scratch, (sizes) => {
    const buffer = takeBuffer(stream, spatialFrameByteLength(sizes));
    const views = spatialFrameViews(buffer, sizes);
    out.buffer = buffer;
    out.views = views;
    return views;
  });
  const { buffer, views } = out;
  if (!buffer || !views) throw new Error("lodFrameStep: the spatial tree was built without its frame buffer");
  const tree = lodTreeFromTopology(topology, { cx: views.cx, cy: views.cy, extent: views.extent }, {
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
  return {
    header: {
      size: topology.size,
      leafCount: n,
      levelCount: topology.levelCount,
      leafBranching: tree.leafBranching,
      box,
      styleVersion: style ? stream.styleVersion : -1,
      frame,
    },
    buffer,
  };
}
