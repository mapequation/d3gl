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
  /** Run this many refinement ticks between progress frames. */
  frameEvery: number;
}

export interface StopMessage {
  type: "stop";
}

export type MainToWorker = StartMessage | StopMessage;

/** A progress frame (`frame`) or the final converged/cancelled state (`done`). */
export interface ProgressMessage {
  type: "frame" | "done";
  /** Finest-level refinement ticks completed so far (0 = the multilevel seed frame). */
  tick: number;
  /** Position snapshot in copy mode; omitted in shared mode (renderer reads the SAB directly). */
  positions?: Float32Array;
}

export type WorkerToMain = ProgressMessage;
