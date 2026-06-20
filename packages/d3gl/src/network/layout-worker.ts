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
import { ForceLayout } from "./force.js";
import { multilevelSeed } from "./coarsen.js";
import type { MainToWorker, StartMessage, WorkerToMain } from "./worker-protocol.js";

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
  const { nodeCount, source, target, weight, sharedPositions, width, height, iterations, force, coarsen, frameEvery } =
    msg;
  const shared = sharedPositions !== undefined;
  const positions = shared ? new Float32Array(sharedPositions) : new Float32Array(nodeCount * 2);
  // Satisfies both CoarsenableGraph (multilevelSeed) and LayoutGraph (ForceLayout).
  const graph = { nodeCount, edgeCount: source.length, source, target, weight, positions };

  // Seed via multilevel coarsening (coarse levels are tiny, so this is fast), publish the seed.
  multilevelSeed(graph, { width, height, iterations, force, coarsen });
  post(shared ? { type: "frame", tick: 0 } : { type: "frame", tick: 0, positions });

  // Stream the finest-level refinement in batches.
  const layout = new ForceLayout(graph, force);
  let done = 0;
  while (done < iterations && !cancelled) {
    const batch = Math.min(frameEvery, iterations - done);
    layout.run(batch);
    done += batch;
    post(shared ? { type: "frame", tick: done } : { type: "frame", tick: done, positions });
    await yieldToEventLoop();
  }

  post(shared ? { type: "done", tick: done } : { type: "done", tick: done, positions });
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
