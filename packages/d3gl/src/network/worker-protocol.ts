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
import type { NestedLayoutParams, NestedLayoutTopology } from "./nested-layout.js";
import type { SeedPlan, SeedPlanOptions } from "./gpu/seed-plan.js";

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
 * many); either way it ends with a `done` carrying the final positions.
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
 * The GPU layout's coarsening worker: coarsen the graph, with no layout, for the LOD tree (#377) and/or the
 * GPU's multilevel seed (#353) — one hierarchy for both, as the worker backend shares it between its seed
 * and its LOD tree. With `seed`, the worker first posts a {@link SeedPlanMessage} (its arrays transferred).
 * With `lod`, it then posts the {@link LODTopologyMessage} once (transferred, not cloned) and answers each
 * {@link LODGeometryRequest} with the tree's position geometry refit to the positions it carries — the work
 * the worker backend does per frame, for positions the GPU harvested. Edge buffers are copied; the main
 * thread keeps its own.
 */
export interface CoarsenMessage {
  type: "coarsen";
  nodeCount: number;
  source: Uint32Array;
  target: Uint32Array;
  weight: Float32Array;
  coarsen?: CoarsenOptions;
  /** Build the LOD tree's topology, post it, and keep the tree for refits. */
  lod: boolean;
  /** Build the GPU multilevel seed's plan from the same hierarchy and post it first. */
  seed?: SeedPlanOptions;
}

/**
 * Refit the coarsen-only tree's position geometry to `positions` (#377). Both buffers are transferred, both
 * ways: `positions` comes back in the reply, and `geometry` is the previous reply's buffer handed back for
 * reuse (absent on the first request, when the worker allocates it) — so a refit allocates nothing.
 */
export interface LODGeometryRequest {
  type: "lod-geometry";
  /** Interleaved `[x, y, …]`, length `2 · nodeCount`. */
  positions: Float32Array;
  /** `[cx, cy, extent]`, length `3 · topology.size` ({@link lodGeometryViews}). */
  geometry?: Float32Array;
}

export type MainToWorker = StartMessage | StopMessage | PinMessage | UnpinMessage | NestedStartMessage | CoarsenMessage | LODGeometryRequest;

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
}

/** The reply to an {@link LODGeometryRequest} (#377): its positions, and `[cx, cy, extent]` refit to them. */
export interface LODGeometryMessage {
  type: "lod-geometry";
  positions: Float32Array;
  geometry: Float32Array;
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
