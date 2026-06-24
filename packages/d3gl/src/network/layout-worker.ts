/**
 * Layout Web Worker entry (sub-issue #102, epic #98).
 *
 * Runs the in-library force layout off the main thread: multilevel-coarsening seed, then stream the
 * finest-level refinement tick-by-tick so the renderer shows the layout converging. All numeric work
 * lives in {@link ./coarsen.js} / {@link ./force.js} — DOM-free, fully typed, shared with the
 * synchronous main-thread path. This file is only the worker-global glue.
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

let cancelled = false;
let busy = false;

function post(message: WorkerToMain): void {
  postMessage(message);
}

function yieldToEventLoop(): Promise<void> {
  // Hand control back so a pending "stop" message is delivered and the worker stays responsive.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function runLayout(msg: StartMessage): Promise<void> {
  busy = true;
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

  const postFrame = (type: "frame" | "done", tick: number): void => {
    if (lodTree) computeLODPositions(lodTree, positions); // writes cx/cy/extent into the geometry buffer
    const message: ProgressMessage = { type, tick };
    if (!shared) message.positions = positions;
    if (lodTree && geomBuffer) message.geometry = new Float32Array(geomBuffer); // copy-mode snapshot
    post(message);
  };

  // Seed: multilevel coarsening (fast — coarse levels are tiny) or a plain disc cold start.
  if (multilevel) multilevelSeed(graph, { width, height, iterations, force, coarsen }, hierarchy);
  else seedPositions(graph, width, height);
  postFrame("frame", 0);

  // Stream the finest-level refinement in batches.
  const layout = new ForceLayout(graph, force);
  let done = 0;
  while (done < iterations && !cancelled) {
    const batch = Math.min(frameEvery, iterations - done);
    layout.run(batch);
    done += batch;
    postFrame("frame", done);
    await yieldToEventLoop();
  }

  postFrame("done", done);
  busy = false;
}

addEventListener("message", (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  if (msg.type === "stop") {
    cancelled = true;
    return;
  }
  if (msg.type === "start" && !busy) void runLayout(msg);
});
