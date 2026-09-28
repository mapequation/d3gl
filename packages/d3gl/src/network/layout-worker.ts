/**
 * Layout Web Worker entry (sub-issue #102, epic #98).
 *
 * Runs the in-library force layout off the main thread: multilevel-coarsening seed — streamed as it
 * forms, so a large graph shows up while its seed still runs (#368) — then stream the finest-level
 * refinement — a frame about every display frame (by time, not tick count) — so the renderer shows
 * the layout converging, until it has converged (#124; the iteration count is only a cap). All
 * numeric work lives in {@link ./coarsen.js} / {@link ./force.js} — DOM-free, fully typed,
 * shared with the synchronous main-thread path. This file is only the worker-global glue.
 *
 * After the initial run converges the worker stays **alive** (idle, not terminated) so an interactive
 * node-drag (#140) can reheat it: a `pin` message holds a node set and resumes the same persistent
 * integration loop at {@link DRAG_HEAT} (the rest of the layout reflows around the held nodes), and
 * `unpin` lets it re-cool until converged again before idling. The loop yields between ticks, so a pin
 * or stop lands within about one tick. State the resume path needs (the graph, the {@link ForceLayout}
 * instance, the LOD tree + geometry buffer) is therefore kept in module scope between runs.
 *
 * A **warm** start (`StartMessage.warm`, #311) continues a layout another transport was running — a GPU
 * layout whose render backend was swapped away, or whose WebGL context was lost: no seed, the positions it
 * left off at, its heat schedule over the ticks it had left. With no ticks left the worker starts idle,
 * alive for a drag reheat.
 *
 * The GPU layout uses the same worker to coarsen, with no layout: `coarsen` builds its multilevel seed's plan
 * (#353) and, with LOD on, its LOD tree (#377), and each `lod-geometry` refits the tree's position geometry to
 * positions the GPU harvested.
 *
 * The page's lib is `["ES2020","DOM"]` (the library targets the browser main thread too), so the
 * worker globals here are typed against `DOM`. The layout's frames use single-argument `postMessage`
 * (no transferables): structured clone copies the snapshot synchronously at post time, so the worker
 * may keep writing its buffer. The LOD refit's messages transfer their buffers instead, through the
 * `DOM` `postMessage(message, { transfer })` overload — so no worker-lib cast is needed either way.
 */
import { DRAG_HEAT, ForceLayout, RECOOL_TICKS, seedPositions } from "./force.js";
import { nestedLayout, nestedBoundaryDiscs } from "./nested-layout.js";
import { nestedSolverBuffers, nestedSolverTopology } from "./gpu/nested-topology.js";
import { multilevelSeedSteps, buildHierarchy, type SeedProgress } from "./coarsen.js";
import { flattenHierarchyToTopology, lodTreeFromTopology, computeLODPositions, type LODPositionTree, type LODTree } from "./lod.js";
import { answerCoarsen, refitGeometry } from "./lod-refit.js";
import {
  lodGeometryViews,
  lodGeometryByteLength,
  type CoarsenMessage,
  type LODGeometryRequest,
  type MainToWorker,
  type NestedPrepReply,
  type ProgressMessage,
  type StartMessage,
  type WorkerToMain,
} from "./worker-protocol.js";

/**
 * Frame budget (ms): the loop posts a frame once this long has passed since the last one — and after
 * any single tick that takes longer — so the stream runs at about display rate whatever the graph size
 * (the main thread coalesces repaints to one per animation frame, so posting faster only adds copies).
 */
const FRAME_MS = 16;
/** Longest the loop ticks without yielding, so a pin / unpin / stop lands within about one tick. */
const YIELD_MS = 4;
/**
 * While the multilevel seed runs, it computes for at least this many times as long as its last
 * progress frame took before posting the next (and never sooner than {@link FRAME_MS}), so posting
 * takes at most a quarter of the seed's time. A seed frame costs O(nodes + LOD tree) — prolongating
 * every node, then the LOD geometry — and a coarse tick can be far shorter than that (#368).
 */
const SEED_FRAME_COST_RATIO = 3;

let cancelled = false;
/** The current loop activity: `idle` (awaiting work), `run` (initial convergence), `drag` (held nodes
 *  pinned, reflow indefinitely), `cool` (post-release settling tail). */
let mode: "idle" | "run" | "drag" | "cool" = "idle";
let looping = false;
/**
 * {@link runLayout} is past its start and has not handed over to {@link loop} yet. The seed yields to
 * the event loop (#368), so without this a `start` landing mid-seed would begin a second run on the
 * same module state. The transport never sends one (a new `layout()` spawns a fresh worker); this keeps
 * the guard on `start` true to that. Left set when a stop ends the seed: the worker is being terminated.
 */
let seeding = false;
let coolLeft = 0;

/** What {@link postFrame} posts: the positions, the LOD tree whose geometry derives from them, and the tick. */
interface FrameSource {
  positions: Float32Array;
  lodTree: LODTree | null;
  /** Copy-mode geometry buffer re-posted each frame; null in shared mode (worker writes the SAB directly). */
  geomBuffer: ArrayBufferLike | null;
  shared: boolean;
  /** Finest-level refinement ticks completed so far (monotonic; reported as `tick`). */
  tick: number;
}

/** Persistent layout state, set by {@link runLayout} and reused by the {@link pin}/{@link unpin} reheat path. */
interface WorkerState extends FrameSource {
  layout: ForceLayout;
  /** Fixed ticks per frame when the caller asked for one; `undefined` streams by {@link FRAME_MS}. */
  frameEvery: number | undefined;
  /** Refinement ticks left in the initial `run`'s budget (drives the `run → drag/idle` transition). */
  runLeft: number;
  /** A node-drag is holding nodes — keep reheating (don't idle) once the initial run finishes. */
  dragging: boolean;
}
let state: WorkerState | null = null;
/**
 * The latest pin that landed while the seed ran (no {@link state} yet). Copy mode: its positions are
 * written over every later progress frame, and {@link runLayout} applies it before the seed frame, so
 * the held nodes show where the drag put them from then on. Shared mode: a pin carries no positions
 * (the main thread writes the held nodes into the SAB), but the seed rewrites every node there, so the
 * held nodes sit where the seed put them until the main thread re-applies the drag — on every pointer
 * move, and before the repaint of every streamed frame — i.e. for the first few refinement ticks.
 */
let pendingPin: { ids: Uint32Array; positions: Float32Array | undefined } | null = null;

function post(message: WorkerToMain, transfer?: Transferable[]): void {
  if (transfer) postMessage(message, { transfer });
  else postMessage(message);
}

/**
 * Hand control back to the event loop so a pending pin / unpin / stop message is delivered. A
 * MessageChannel round trip, not `setTimeout(0)` — timers are clamped to ≥ 4 ms once nested, which
 * would idle the worker between every slice of ticks.
 */
const yieldChannel = new MessageChannel();
let wake: (() => void) | null = null;
yieldChannel.port1.onmessage = (): void => {
  const resolve = wake;
  wake = null;
  resolve?.();
};
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    wake = resolve;
    yieldChannel.port2.postMessage(null);
  });
}

function postFrame(type: "frame" | "done", s: FrameSource | null = state): void {
  if (!s) return;
  if (s.lodTree) computeLODPositions(s.lodTree, s.positions); // writes cx/cy/extent into the geometry buffer
  const message: ProgressMessage = { type, tick: s.tick };
  if (!s.shared) message.positions = s.positions;
  if (s.lodTree && s.geomBuffer) message.geometry = new Float32Array(s.geomBuffer); // copy-mode snapshot
  post(message);
}

/** Leave the initial run: keep reflowing if a drag is live, else rest. */
function endRun(s: WorkerState): void {
  if (s.dragging) {
    mode = "drag";
    s.layout.hold(DRAG_HEAT);
  } else mode = "idle";
}

/**
 * The single persistent integration loop. Ticks the {@link ForceLayout} one step at a time, posting a
 * frame by time ({@link FRAME_MS}) and yielding every {@link YIELD_MS} so pins and stops land between
 * ticks, until `mode` returns to `idle` — then posts `done` with the final positions. The initial run
 * ends when the layout converges (or its tick budget runs out), the post-drag re-cool likewise; a drag
 * reflows until released. Re-entrant-safe via {@link looping}; the seed frame is posted by the caller.
 */
async function loop(): Promise<void> {
  if (looping || !state) return;
  looping = true;
  const s = state;
  let lastPost = performance.now();
  let lastYield = lastPost;
  let ticksSincePost = 0;
  while (!cancelled && mode !== "idle") {
    s.layout.tick();
    s.tick++;
    ticksSincePost++;
    if (mode === "run") {
      s.runLeft--;
      if (s.runLeft <= 0 || s.layout.converged) endRun(s);
    } else if (mode === "cool") {
      coolLeft--;
      if (coolLeft <= 0 || s.layout.converged) mode = "idle";
    }
    if (mode === "idle") break; // the `done` below carries these positions
    const now = performance.now();
    if (s.frameEvery !== undefined ? ticksSincePost >= s.frameEvery : now - lastPost >= FRAME_MS) {
      postFrame("frame");
      lastPost = now;
      ticksSincePost = 0;
    }
    if (now - lastYield >= YIELD_MS) {
      await yieldToEventLoop();
      lastYield = performance.now();
    }
  }
  if (!cancelled) postFrame("done"); // reached rest; stay alive (idle) for a later reheat
  looping = false;
}

/**
 * Run the multilevel seed a tick at a time (#368), posting the seed so far as a progress frame (tick
 * 0: every node prolongated from the coarse level being solved, at the finished seed's extent — only
 * {@link SeedProgress.atScale} steps) — the first at least {@link FRAME_MS} in, then paced by
 * {@link SEED_FRAME_COST_RATIO} — and yielding every {@link YIELD_MS} so a stop or pin lands mid-seed.
 * A frame posted after a pin landed shows the held nodes where the drag put them (copy mode, see
 * {@link pendingPin}). Resolves `false` when stopped.
 */
async function seedProgressively(steps: Generator<SeedProgress, void, undefined>, frame: FrameSource): Promise<boolean> {
  let lastPost = performance.now();
  let lastYield = lastPost;
  let wait = FRAME_MS;
  for (const step of steps) {
    const now = performance.now();
    if (step.atScale && now - lastPost >= wait) {
      step.prolongate();
      if (pendingPin?.positions) writeHeld(frame.positions, pendingPin.ids, pendingPin.positions);
      postFrame("frame", frame);
      lastPost = performance.now();
      wait = Math.max(FRAME_MS, SEED_FRAME_COST_RATIO * (lastPost - now));
    }
    if (now - lastYield >= YIELD_MS) {
      await yieldToEventLoop();
      if (cancelled) return false;
      lastYield = performance.now();
    }
  }
  return !cancelled;
}

async function runLayout(msg: StartMessage): Promise<void> {
  seeding = true;
  cancelled = false;
  const { nodeCount, source, target, weight, sharedPositions, width, height, iterations, force, coarsen, multilevel, frameEvery, lod, warm } =
    msg;
  const shared = sharedPositions !== undefined;
  // A warm start's copy-mode positions arrived as this worker's own clone: continue in them.
  const positions = shared ? new Float32Array(sharedPositions) : (warm?.positions ?? new Float32Array(nodeCount * 2));
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
    // The main thread adopts the tree the moment it lands. A cold start's seed frame follows at once, but a
    // warm start's first frame only follows its first tick (#311), so its geometry goes with the tree: in
    // the SAB (shared mode) or in the message (copy mode, cloned at post time).
    let geometry: Float32Array | undefined;
    if (warm) {
      computeLODPositions(lodTree, positions);
      if (!shared) geometry = new Float32Array(buffer);
    }
    post({ type: "lod-topology", topology, sharedGeometry, geometry });
  }

  // Seed: multilevel coarsening, streamed as it forms (a 300k-node seed takes ~1 s), or a plain disc
  // cold start. A warm start (#311) continues positions another transport left off at: no seed.
  if (!warm) {
    if (multilevel) {
      const steps = multilevelSeedSteps(graph, { width, height, iterations, force, coarsen }, hierarchy);
      if (!(await seedProgressively(steps, { positions, lodTree, geomBuffer, shared, tick: 0 }))) return; // stopped
    } else seedPositions(graph, width, height, { force });
  }

  const layout = new ForceLayout(graph, force);
  if (warm) {
    // Continue a layout another transport was running (#311): its positions are already on screen, so
    // there is no seed and no seed frame; its heat schedule goes on over the ticks left.
    if (warm.decaying) layout.cool(iterations, warm.heat);
    else layout.hold(warm.heat);
  } else if (multilevel) {
    // A multilevel seed already has the global arrangement: cool over the budget. A cold disc start
    // still has to untangle, so it keeps full heat (see ForceLayout.run). Either way the loop stops
    // once the layout has converged.
    layout.cool(iterations);
  } else layout.hold(1);
  const s: WorkerState = { layout, positions, lodTree, geomBuffer, shared, frameEvery, runLeft: iterations, dragging: false, tick: 0 };
  state = s;
  seeding = false;

  // Stream the finest-level refinement via the shared loop; it idles when converged (worker stays alive).
  // A warm re-cool's tail resumes as a re-cool, so a pin there reheats at once, as it would have (#311).
  mode = iterations > 0 ? (warm?.recool ? "cool" : "run") : "idle";
  if (mode === "cool") coolLeft = iterations;
  // A drag that began on a progress frame: hold its nodes from the seed frame on — its positions and the
  // LOD geometry derived from them — and from the first refinement tick.
  const held = pendingPin;
  pendingPin = null;
  if (held) holdNodes(s, held.ids, held.positions);
  if (!warm) postFrame("frame"); // seed frame (tick 0); a warm start's positions are already on screen
  await loop();
}

/**
 * The GPU layout's coarsening (#377, #353): coarsen only — no layout, no graph kept. The seed plan and the LOD
 * topology go to the main thread by transfer (the worker keeps its own copies of what a refit reads), and the
 * graph's edges are dropped with this call: a refit needs only the tree.
 */
let refitTree: LODPositionTree | null = null;
function coarsenOnly(msg: CoarsenMessage): void {
  refitTree = answerCoarsen(msg, (message, transfer) => post(message, transfer));
}

/** Refit the coarsen-only tree to the GPU's harvested positions and hand both buffers back (#377). */
function refitLOD(msg: LODGeometryRequest): void {
  const tree = refitTree;
  if (!tree) return; // the main thread requests refits only after the topology arrived
  const buffer = msg.geometry?.buffer ?? new ArrayBuffer(lodGeometryByteLength(tree.size));
  const geometry = refitGeometry(tree, msg.positions, buffer);
  post({ type: "lod-geometry", positions: msg.positions, geometry }, [msg.positions.buffer, geometry.buffer]);
}

/** Write the held nodes' positions (interleaved, in `ids` order) into `positions`. */
function writeHeld(positions: Float32Array, ids: Uint32Array, held: Float32Array): void {
  let k = 0;
  for (const id of ids) {
    positions[id * 2] = held[k++] ?? 0;
    positions[id * 2 + 1] = held[k++] ?? 0;
  }
}

/** Pin `ids` on the live {@link ForceLayout} and switch to reheating; in copy mode also write the held
 *  positions into the worker's buffer so its snapshot + geometry reflect them. Does not start the loop. */
function holdNodes(s: WorkerState, ids: Uint32Array, positions: Float32Array | undefined): void {
  s.layout.setPinned(ids);
  if (positions) writeHeld(s.positions, ids, positions);
  s.dragging = true;
  // A drag during the initial run rides on the run's own schedule — a cold start's full heat, or the
  // cooling budget — until the run converges or spends its budget, then holds DRAG_HEAT (endRun).
  // Otherwise reflow at the drag heat now.
  if (mode === "idle" || mode === "cool") {
    mode = "drag";
    s.layout.hold(DRAG_HEAT);
  }
}

/** Hold `ids` and reheat (#140) via {@link holdNodes}. While the seed runs there is no layout to pin
 *  yet: the latest pin waits for {@link runLayout} ({@link pendingPin}). */
function pin(ids: Uint32Array, positions?: Float32Array): void {
  const s = state;
  if (!s) {
    pendingPin = { ids, positions };
    return;
  }
  holdNodes(s, ids, positions);
  if (!looping) void loop();
}

/** Release every pin and re-cool (until converged, at most {@link RECOOL_TICKS}), then idle (#140). */
function unpin(): void {
  const s = state;
  if (!s) {
    pendingPin = null; // released before the seed finished
    return;
  }
  s.layout.setPinned(null);
  s.dragging = false;
  if (mode === "drag") {
    mode = "cool";
    coolLeft = RECOOL_TICKS;
    s.layout.cool(RECOOL_TICKS, DRAG_HEAT);
  }
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
      if (!looping && !seeding) void runLayout(msg);
      return;
    case "coarsen":
      coarsenOnly(msg);
      return;
    case "lod-geometry":
      refitLOD(msg);
      return;
    case "start-nested": {
      // One synchronous top-down pass (each depth final); a `stop` can only land after it, and the main
      // thread terminates the worker on stop anyway.
      const result = nestedLayout(msg.topology, {
        ...msg.params,
        onDepth: msg.stream ? (depth, frame) => post({ type: "frame", tick: depth, positions: frame }) : undefined,
      });
      post({ type: "done", tick: -1, positions: result.positions, boundaries: nestedBoundaryDiscs(msg.topology, result) });
      return;
    }
    case "nested-prep": {
      // The GPU nested layout's CPU prep (#355): its arrays are transferred, not copied.
      const solver = nestedSolverTopology(msg.topology, msg.params);
      const reply: NestedPrepReply = { type: "nested-prep", solver };
      postMessage(reply, { transfer: nestedSolverBuffers(solver) });
      return;
    }
  }
});
