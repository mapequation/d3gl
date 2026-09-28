/**
 * Message protocol between the main thread and the layout Web Worker (sub-issue #102, epic #98).
 *
 * Positions travel one of two ways, chosen at runtime by the page's capabilities:
 * - **Shared** (`sharedPositions` present): a `SharedArrayBuffer` the worker writes and the renderer
 *   reads live — zero-copy progressive rendering. Requires a cross-origin-isolated page.
 * - **Copy** (no `sharedPositions`): the worker includes a `positions` snapshot on each frame, which
 *   the main thread copies into the graph. The structured clone is synchronous at post time, so the
 *   worker may keep mutating its buffer immediately after.
 */
import type { ForceParams } from "./force.js";
import type { CoarsenOptions } from "./coarsen.js";
import type { BoundaryDiscs, LODTopology } from "./lod.js";
import type { LeafStyle, LODView, SpatialLODFrame } from "./lod-frame.js";
import type { NestedLayoutParams, NestedLayoutTopology } from "./nested-layout.js";
import type { SeedPlan, SeedPlanOptions } from "./gpu/seed-plan.js";
import type { NestedSolverTopology } from "./gpu/nested-topology.js";
import type { FitBox } from "./fit.js";

/** Kick off a layout run. Edge buffers are copied to the worker; the main thread keeps its own. */
export interface StartMessage {
  type: "start";
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
  /** Present only in shared (zero-copy) mode. */
  sharedPositions?: SharedArrayBuffer;
  width: number;
  height: number;
  iterations: number;
  force?: Partial<ForceParams>;
  coarsen?: CoarsenOptions;
  /** Seed via multilevel coarsening (`true`) or a plain disc cold start (`false`). */
  multilevel: boolean;
  /**
   * Run exactly this many refinement ticks between progress frames. Omitted (the default), the worker
   * streams by time instead: a frame about every display frame, and after any longer tick.
   */
  frameEvery?: number;
  /**
   * Build the structural LOD tree on the worker and stream it (#103): the worker posts the tree
   * {@link LODTopology} once, then refreshes its position-derived geometry (`cx`/`cy`/`extent`) each
   * frame — shared via a SAB, or in the per-frame message in copy mode — so the main thread renders
   * the LOD frontier with no O(N) coarsening or geometry pass of its own.
   */
  lod?: boolean;
  /**
   * Which tree the worker streams with `lod` (#343): `"structure"` (default) posts the coarsening tree's
   * topology once and refits its geometry each frame; `"spatial"` rebuilds a Morton tree every streamed frame
   * and transfers it whole with the frame ({@link ProgressMessage.lodFrame}), with its super-edge rows while
   * `lodStyle.links` (#433). The worker still coarsens for the multilevel seed either way.
   */
  lodSource?: "structure" | "spatial";
  /** The leaf style a spatial tree aggregates onto every rebuild (#343), and its version (echoed per frame). */
  lodStyle?: LeafStyle;
  lodStyleVersion?: number;
  /** The main thread's view, whose kept glyphs' super-edge rows a spatial tree carries (#433). */
  lodView?: LODView;
  /**
   * Continue a layout another transport was running (#311) instead of seeding one: no disc, no multilevel
   * seed, no seed frame. `iterations` is the ticks left of its budget; 0 starts the worker idle, alive for
   * a drag reheat.
   */
  warm?: WarmStart;
}

/**
 * Where a layout left off, for a worker that continues it (#311): its positions and its heat schedule.
 * `cool(iterations, heat)` continues a decaying schedule (see `Cooling.decaying`), `hold(heat)` a held one.
 */
export interface WarmStart {
  /** Copy mode: the positions to continue from. Omitted in shared mode, where they are in `sharedPositions`. */
  positions?: Float32Array;
  /** The heat of the next tick. */
  heat: number;
  /** Whether that heat decays to the floor over `iterations` ticks, or is held. */
  decaying: boolean;
  /**
   * The ticks are the tail of a re-cool after a drag: the worker resumes it as one, so a pin reheats at the
   * drag heat at once instead of riding the tail's decaying heat, as a drag during the initial run does.
   */
  recool?: boolean;
}

/** A new leaf style for the spatial tree's per-frame aggregation (#343), after `style()` changed it — to a
 *  layout worker's stream, or to a GPU layout's LOD worker streaming the spatial tree. */
export interface LODStyleMessage {
  type: "lod-style";
  style: LeafStyle;
  version: number;
}

/** The main thread's view changed (#433): later spatial trees carry the super-edge rows of the glyphs it keeps. */
export interface LODViewMessage {
  type: "lod-view";
  view: LODView;
}

/** A spatial frame's buffer handed back for reuse once its tree is no longer drawn (#343; transferred) — by the
 *  worker backend, or by a GPU layout's LOD relay — with its super-edge rows buffer when it carried one (#433). */
export interface LODRecycleMessage {
  type: "lod-recycle";
  buffer: ArrayBuffer;
  rows?: ArrayBuffer;
}

export interface StopMessage {
  type: "stop";
}

/**
 * Pin (hold) a set of nodes for an interactive drag (#140), and resume integration so the rest of the
 * layout reheats around them. Sent on drag start and again whenever the held positions change. The
 * worker {@link ForceLayout.setPinned}s `ids` (skipped by integration) and — in **copy mode** — writes
 * `positions` into its own buffer first, so its streamed snapshot + LOD geometry reflect the held
 * nodes. In **shared mode** the main thread writes the held positions straight into the position SAB,
 * so `positions` is omitted. After the initial layout converged the worker idles (alive, not
 * terminated); this message wakes it.
 */
export interface PinMessage {
  type: "pin";
  /** Held node ids (skipped by integration; still repel + anchor springs). */
  ids: Uint32Array;
  /** Copy mode only: interleaved `[x, y, …]` for `ids` in order — the worker writes these before integrating. */
  positions?: Float32Array;
}

/** Release every pin (drag ended) and let the layout re-cool over a short tail of ticks, then idle (#140). */
export interface UnpinMessage {
  type: "unpin";
}

/**
 * Run the nested module layout (#324) instead of a force layout. With `stream`, the worker posts one
 * `frame` per finished depth (`tick` = depth, positions always copied — there are only tree-depth
 * many — with the depth's `bounds`, #427); either way it ends with a `done` carrying the final positions.
 */
export interface NestedStartMessage {
  type: "start-nested";
  topology: NestedLayoutTopology;
  params: NestedLayoutParams;
  /** Post a frame per finished depth. Off for a warm start or a transition (#328), which only want
   *  the final layout. */
  stream: boolean;
}

/**
 * Build the batched GPU nested layout's solve data off the main thread (#355): the worker replies with
 * one {@link NestedPrepReply} (its buffers transferred) and is then done. O(tree size + links · log links).
 */
export interface NestedPrepMessage {
  type: "nested-prep";
  topology: NestedLayoutTopology;
  params: NestedLayoutParams;
}

/**
 * The GPU layout's coarsening worker: coarsen the graph, with no layout, for the LOD tree (#377) and/or the
 * GPU's multilevel seed (#353) — one hierarchy for both, as the worker backend shares it between its seed
 * and its LOD tree. With `seed`, the worker first posts a {@link SeedPlanMessage} (its arrays transferred).
 * With `lod`, it then posts the {@link LODTopologyMessage} once (transferred, not cloned) and answers each
 * {@link LODGeometryRequest} with the tree's position geometry refit to the positions it carries — the work
 * the worker backend does per frame, for positions the GPU harvested. With `lodSource: "spatial"` (#343) it
 * posts no topology and coarsens only for the seed: each request rebuilds the spatial tree for its positions
 * instead, as the worker backend does per frame, and the reply transfers it. Edge buffers are copied; the
 * main thread keeps its own.
 */
export interface CoarsenMessage {
  type: "coarsen";
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
  coarsen?: CoarsenOptions;
  /** Stream the LOD tree: the structure tree's topology posted once and refit per request, or the spatial
   *  tree rebuilt per request ({@link lodSource}). */
  lod: boolean;
  /** Which tree `lod` streams (#343): `"structure"` (default) or `"spatial"`. */
  lodSource?: "structure" | "spatial";
  /** The leaf style a spatial tree aggregates onto every rebuild (#343), and its version (echoed per frame). */
  lodStyle?: LeafStyle;
  lodStyleVersion?: number;
  /** The main thread's view, whose kept glyphs' super-edge rows a spatial tree carries (#433). */
  lodView?: LODView;
  /** Build the GPU multilevel seed's plan from the same hierarchy and post it first. */
  seed?: SeedPlanOptions;
}

/**
 * One relayed frame of the GPU layout's LOD worker (#377): the worker runs the per-frame LOD step for
 * `positions` — refits the coarsen-only tree's position geometry, or rebuilds the spatial tree (#343). Both
 * buffers are transferred, both ways: `positions` comes back in the reply, and `geometry` is the previous
 * reply's buffer handed back for reuse (absent on the first request, when the worker allocates it, and for a
 * spatial stream, whose frames come back through {@link LODRecycleMessage}) — so a refit allocates nothing.
 */
export interface LODGeometryRequest {
  type: "lod-geometry";
  /** Interleaved `[x, y, …]`, length `2 · nodeCount`. */
  positions: Float32Array;
  /** The frame id: the ticks the positions hold. A spatial stream skips a frame id it already built (the
   *  layout has not moved since: converged), as the worker backend's step skips a tick it built. */
  frame: number;
  /** `[cx, cy, extent]`, length `3 · topology.size` ({@link lodGeometryViews}). */
  geometry?: Float32Array;
}

export type MainToWorker =
  | StartMessage
  | StopMessage
  | PinMessage
  | UnpinMessage
  | NestedStartMessage
  | LODStyleMessage
  | LODViewMessage
  | LODRecycleMessage
  | CoarsenMessage
  | LODGeometryRequest
  | NestedPrepMessage;

/**
 * The LOD tree, posted once after the worker coarsens (only when `lod` was requested, or for a
 * {@link CoarsenMessage}). `topology`'s typed arrays are structured-cloned to the main thread — transferred
 * for a {@link CoarsenMessage}; in shared mode `sharedGeometry` is the SAB the worker writes the per-frame
 * `cx`/`cy`/`extent` into (laid out by {@link lodGeometryViews}).
 */
export interface LODTopologyMessage {
  type: "lod-topology";
  topology: LODTopology;
  /** Shared (zero-copy) mode: the geometry SAB the worker updates each frame; absent in copy mode. */
  sharedGeometry?: SharedArrayBuffer;
  /**
   * Copy mode, a warm start only (#311): the geometry of the positions it continues from, laid out as a
   * frame's {@link ProgressMessage.geometry}. No seed frame follows a warm start, and the main thread draws
   * the tree as soon as it lands. (Shared mode fills `sharedGeometry` before posting instead.)
   */
  geometry?: Float32Array;
}

/** A progress frame (`frame`) or the final converged/cancelled state (`done`). */
export interface ProgressMessage {
  type: "frame" | "done";
  /** Finest-level refinement ticks completed so far: 0 for the multilevel seed frame, and for the
   *  progress frames before it while the seed still runs (#368). A `done` carries the tick the layout
   *  stopped at: converged, or out of its iteration budget. */
  tick: number;
  /** Position snapshot in copy mode; omitted in shared mode (renderer reads the SAB directly). */
  positions?: Float32Array;
  /**
   * LOD geometry snapshot (`[cx, cy, extent]` concatenated, length `3 · topology.size`) in copy mode
   * when LOD is on; omitted in shared mode (the renderer reads the geometry SAB directly).
   */
  geometry?: Float32Array;
  /** A nested layout's `done` (#329): its module boundary discs, for `lod({ moduleBoundary })`. */
  boundaries?: BoundaryDiscs;
  /**
   * The spatial LOD tree rebuilt for this frame's positions (#343, `lodSource: "spatial"`), its buffer — and
   * its super-edge rows' (#433) — transferred. Absent when the positions did not move since the last one
   * (the layout converged).
   */
  lodFrame?: SpatialLODFrame;
  /** A nested layout's depth `frame` (#427): a box its final layout lies in (the `bounds` of
   *  `nestedLayout`'s `onDepth`), for a streaming fit to frame. */
  bounds?: FitBox;
}

/**
 * The reply to an {@link LODGeometryRequest} (#377): its positions, and — from a structure stream —
 * `[cx, cy, extent]` refit to them, or — from a spatial stream (#343) — the spatial tree rebuilt for them.
 */
export interface LODGeometryMessage {
  type: "lod-geometry";
  positions: Float32Array;
  /** The structure tree's geometry refit to `positions` (the request's buffer, when it handed one back). */
  geometry?: Float32Array;
  /** The spatial tree rebuilt for `positions`, its buffer transferred. Absent when the request's frame id was
   *  already built (the layout converged). */
  lodFrame?: SpatialLODFrame;
}

/**
 * The GPU multilevel seed's plan (#353), the first reply to a {@link CoarsenMessage} with `seed` — its arrays
 * transferred. `null` when the graph cannot be coarsened: the GPU run starts from its disc.
 */
export interface SeedPlanMessage {
  type: "seed-plan";
  plan: SeedPlan | null;
}

export type WorkerToMain = LODTopologyMessage | ProgressMessage | LODGeometryMessage | SeedPlanMessage;

/** The reply to a {@link NestedPrepMessage}: the GPU nested solve's data (#355). Its own channel, not a layout message. */
export interface NestedPrepReply {
  type: "nested-prep";
  solver: NestedSolverTopology;
}

/**
 * The three position-derived geometry arrays packed contiguously in one buffer, `[cx, cy, extent]`
 * each of length `size`. One layout shared by the worker (writer) and the main thread (reader), over
 * either a `SharedArrayBuffer` (zero-copy) or a transferred copy.
 */
export function lodGeometryViews(
  buffer: ArrayBufferLike,
  size: number,
): { cx: Float32Array; cy: Float32Array; extent: Float32Array } {
  return {
    cx: new Float32Array(buffer, 0, size),
    cy: new Float32Array(buffer, size * Float32Array.BYTES_PER_ELEMENT, size),
    extent: new Float32Array(buffer, 2 * size * Float32Array.BYTES_PER_ELEMENT, size),
  };
}

/** Byte length of the LOD geometry buffer for a tree of `size` nodes (`[cx, cy, extent]`). */
export function lodGeometryByteLength(size: number): number {
  return 3 * size * Float32Array.BYTES_PER_ELEMENT;
}
