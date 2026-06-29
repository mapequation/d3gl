/**
 * Layout Web Worker entry (sub-issue #102, epic #98).
 *
 * Runs the in-library force layout off the main thread: multilevel-coarsening seed, then stream the
 * finest-level refinement tick-by-tick so the renderer shows the layout converging. All numeric work
 * lives in {@link ./coarsen.js} / {@link ./force.js} — DOM-free, fully typed, shared with the
 * synchronous main-thread path. This file is only the worker-global glue.
 *
 * After the initial run converges the worker stays **alive** (idle, not terminated) so an interactive
 * node-drag (#140) can reheat it: a `pin` message holds a node set and resumes the same persistent
 * integration loop (the rest of the layout reflows around the held nodes), and `unpin` lets it re-cool
 * over a short tail before idling again. State the resume path needs (the graph, the {@link ForceLayout}
 * instance, the LOD tree + geometry buffer) is therefore kept in module scope between runs.
 *
 * The page's lib is `["ES2020","DOM"]` (the library targets the browser main thread too), so the
 * worker globals here are typed against `DOM`. We deliberately use single-argument `postMessage`
 * (no transferables): structured clone copies the snapshot synchronously at post time, which the
 * `DOM` `postMessage(message, options?)` overload accepts — so no worker-lib cast is needed.
 */
import { ForceLayout, seedPositions } from "./force.js";
import { multilevelSeed, buildHierarchy } from "./coarsen.js";
import { flattenHierarchyToTopology, lodTreeFromTopology, computeLODPositions, type LODTree } from "./lod.js";
import {
  lodGeometryViews,
  lodGeometryByteLength,
  type MainToWorker,
  type ProgressMessage,
  type StartMessage,
  type WorkerToMain,
} from "./worker-protocol.js";

/** Ticks per streamed frame while reheating (drag / cool) — small batches keep the stream responsive. */
const REHEAT_BATCH = 3;
/** Tail of refinement ticks after a drag releases, so the layout re-cools instead of freezing mid-reflow. */
const COOL_TICKS = 120;

let cancelled = false;
/** The current loop activity: `idle` (awaiting work), `run` (initial fixed-iteration convergence),
 *  `drag` (held nodes pinned, reflow indefinitely), `cool` (post-release settling tail). */
let mode: "idle" | "run" | "drag" | "cool" = "idle";
let looping = false;
let coolLeft = 0;

/** Persistent layout state, set by {@link runLayout} and reused by the {@link pin}/{@link unpin} reheat path. */
interface WorkerState {
  layout: ForceLayout;
  positions: Float32Array;
  lodTree: LODTree | null;
  /** Copy-mode geometry buffer re-posted each frame; null in shared mode (worker writes the SAB directly). */
  geomBuffer: ArrayBufferLike | null;
  shared: boolean;
  frameEvery: number;
  /** Refinement ticks remaining in the initial `run` (drives the `run → drag/idle` transition). */
  runLeft: number;
  /** A node-drag is holding nodes — keep reheating (don't idle) once the initial run finishes. */
  dragging: boolean;
  /** Finest-level refinement ticks completed so far (monotonic; reported as `tick`). */
  tick: number;
}
let state: WorkerState | null = null;

function post(message: WorkerToMain): void {
  postMessage(message);
}

function yieldToEventLoop(): Promise<void> {
  // Hand control back so a pending pin/unpin/stop message is delivered and the worker stays responsive.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function postFrame(type: "frame" | "done"): void {
  const s = state;
  if (!s) return;
  if (s.lodTree) computeLODPositions(s.lodTree, s.positions); // writes cx/cy/extent into the geometry buffer
  const message: ProgressMessage = { type, tick: s.tick };
  if (!s.shared) message.positions = s.positions;
  if (s.lodTree && s.geomBuffer) message.geometry = new Float32Array(s.geomBuffer); // copy-mode snapshot
  post(message);
}

/**
 * The single persistent integration loop. Ticks the {@link ForceLayout} in batches and streams a frame
 * after each, until `mode` returns to `idle`. Re-entrant-safe via {@link looping}; the seed frame is
 * posted by the caller before the first activation.
 */
async function loop(): Promise<void> {
  if (looping || !state) return;
  looping = true;
  const s = state;
  while (!cancelled && mode !== "idle") {
    // Clamp the initial run's last batch to the iterations remaining (so `tick` never overshoots the
    // requested count); reheat (drag/cool) streams in small fixed batches for responsiveness.
    const batch = mode === "run" ? Math.min(s.frameEvery, s.runLeft) : REHEAT_BATCH;
    s.layout.run(batch);
    s.tick += batch;
    postFrame("frame");
    if (mode === "run") {
      s.runLeft -= batch;
      if (s.runLeft <= 0) mode = s.dragging ? "drag" : "idle"; // converged → keep reflowing if a drag is live
    } else if (mode === "cool") {
      coolLeft -= batch;
      if (coolLeft <= 0) mode = "idle";
    }
    await yieldToEventLoop();
  }
  if (!cancelled) postFrame("done"); // reached rest; stay alive (idle) for a later reheat
  looping = false;
}

async function runLayout(msg: StartMessage): Promise<void> {
  cancelled = false;
  const { nodeCount, source, target, weight, sharedPositions, width, height, iterations, force, coarsen, multilevel, frameEvery, lod } =
    msg;
  const shared = sharedPositions !== undefined;
  const positions = shared ? new Float32Array(sharedPositions) : new Float32Array(nodeCount * 2);
  // Satisfies both CoarsenableGraph (multilevelSeed) and LayoutGraph (ForceLayout / seedPositions).
  const graph = { nodeCount, edgeCount: source.length, source, target, weight, positions };

  // LOD (#103): coarsen once and reuse that hierarchy for both the multilevel seed and the streamed
  // tree, so the graph is never coarsened twice and the main thread never coarsens at all. The worker
  // owns the position-derived geometry (`cx`/`cy`/`extent`) — recomputed each frame, written to a SAB
  // (shared mode) or posted with the frame (copy mode); the main thread fills the style-derived
  // geometry once and runs only the O(visible) cut.
  const hierarchy = lod ? buildHierarchy(graph, coarsen) : undefined;
  let lodTree: LODTree | null = null;
  let geomBuffer: ArrayBufferLike | null = null; // copy-mode buffer re-posted each frame
  if (lod && hierarchy) {
    // Pass the edges so the streamed tree carries the flow-weighted super-edge CSR too — the unified
    // super-edge path needs it on the worker (coarsening) tree just like the main-thread one.
    const topology = flattenHierarchyToTopology(hierarchy, nodeCount, { source, target, weight });
    const byteLength = lodGeometryByteLength(topology.size);
    let sharedGeometry: SharedArrayBuffer | undefined;
    let buffer: ArrayBufferLike;
    if (shared) {
      sharedGeometry = new SharedArrayBuffer(byteLength);
      buffer = sharedGeometry;
    } else {
      buffer = new ArrayBuffer(byteLength);
      geomBuffer = buffer;
    }
    lodTree = lodTreeFromTopology(topology, lodGeometryViews(buffer, topology.size));
    post({ type: "lod-topology", topology, sharedGeometry });
  }

  // Seed: multilevel coarsening (fast — coarse levels are tiny) or a plain disc cold start.
  if (multilevel) multilevelSeed(graph, { width, height, iterations, force, coarsen }, hierarchy);
  else seedPositions(graph, width, height);

  state = { layout: new ForceLayout(graph, force), positions, lodTree, geomBuffer, shared, frameEvery, runLeft: iterations, dragging: false, tick: 0 };
  postFrame("frame"); // seed frame (tick 0)

  // Stream the finest-level refinement via the shared loop; it idles when converged (worker stays alive).
  mode = iterations > 0 ? "run" : "idle";
  await loop();
}

/** Hold `ids` and reheat (#140). Applies the pins to the live {@link ForceLayout}; in copy mode also
 *  writes the held positions into the worker's buffer so its snapshot + geometry reflect them. */
function pin(ids: Uint32Array, positions?: Float32Array): void {
  const s = state;
  if (!s) return;
  s.layout.setPinned(ids);
  if (positions) for (let k = 0; k < ids.length; k++) {
    const id = ids[k]!;
    s.positions[id * 2] = positions[k * 2]!;
    s.positions[id * 2 + 1] = positions[k * 2 + 1]!;
  }
  s.dragging = true;
  if (mode === "idle" || mode === "cool") mode = "drag"; // keep `run` running; it transitions to drag on finish
  if (!looping) void loop();
}

/** Release every pin and re-cool over a short tail of ticks, then idle (#140). */
function unpin(): void {
  const s = state;
  if (!s) return;
  s.layout.setPinned(null);
  s.dragging = false;
  if (mode === "drag") { mode = "cool"; coolLeft = COOL_TICKS; }
  if (!looping) void loop();
}

addEventListener("message", (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case "stop":
      // The main thread posts `stop` only immediately before `worker.terminate()` (see
      // WorkerLayoutHandle.stop), so `cancelled` is never reset — this worker is about to die. A new
      // `layout()` always spins up a FRESH worker, so a single worker never sees `start` twice.
      cancelled = true;
      mode = "idle";
      return;
    case "pin":
      pin(msg.ids, msg.positions);
      return;
    case "unpin":
      unpin();
      return;
    case "start":
      if (!looping) void runLayout(msg);
      return;
  }
});
