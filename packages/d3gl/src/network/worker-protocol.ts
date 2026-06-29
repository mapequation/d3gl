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
import type { LODTopology } from "./lod.js";

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
  /** Run this many refinement ticks between progress frames. */
  frameEvery: number;
  /**
   * Build the structural LOD tree on the worker and stream it (#103): the worker posts the tree
   * {@link LODTopology} once, then refreshes its position-derived geometry (`cx`/`cy`/`extent`) each
   * frame — shared via a SAB, or in the per-frame message in copy mode — so the main thread renders
   * the LOD frontier with no O(N) coarsening or geometry pass of its own.
   */
  lod?: boolean;
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

export type MainToWorker = StartMessage | StopMessage | PinMessage | UnpinMessage;

/**
 * The LOD tree, posted once after the worker coarsens (only when `lod` was requested). `topology`'s
 * typed arrays are structured-cloned to the main thread; in shared mode `sharedGeometry` is the SAB
 * the worker writes the per-frame `cx`/`cy`/`extent` into (laid out by {@link lodGeometryViews}).
 */
export interface LODTopologyMessage {
  type: "lod-topology";
  topology: LODTopology;
  /** Shared (zero-copy) mode: the geometry SAB the worker updates each frame; absent in copy mode. */
  sharedGeometry?: SharedArrayBuffer;
}

/** A progress frame (`frame`) or the final converged/cancelled state (`done`). */
export interface ProgressMessage {
  type: "frame" | "done";
  /** Finest-level refinement ticks completed so far (0 = the multilevel seed frame). */
  tick: number;
  /** Position snapshot in copy mode; omitted in shared mode (renderer reads the SAB directly). */
  positions?: Float32Array;
  /**
   * LOD geometry snapshot (`[cx, cy, extent]` concatenated, length `3 · topology.size`) in copy mode
   * when LOD is on; omitted in shared mode (the renderer reads the geometry SAB directly).
   */
  geometry?: Float32Array;
}

export type WorkerToMain = LODTopologyMessage | ProgressMessage;

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
