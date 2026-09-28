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
 * With LOD on, every posted frame runs the one per-frame LOD step ({@link lodFrameStep}, #343): refit the
 * coarsening tree in place (`lodSource: "structure"`), or rebuild the spatial tree — with the super-edge
 * rows of the main thread's view's covers (#433), so its link gather stays O(visible) — and transfer it with
 * the frame (`"spatial"`).
 *
 * The GPU layout uses the same worker to coarsen, with no layout: `coarsen` builds its multilevel seed's plan
 * (#353) and, with LOD on, its LOD tree (#377), and each `lod-geometry` refits the tree's position geometry to
 * positions the GPU harvested.
 *
 * The page's lib is `["ES2020","DOM"]` (the library targets the browser main thread too), so the
 * worker globals here are typed against `DOM`. Positions use single-argument `postMessage` (no
 * transferables): structured clone copies the snapshot synchronously at post time, so the worker may keep
 * writing its buffer. A spatial frame's buffers and the LOD refit's messages are transferred instead,
 * through the `DOM` `postMessage(message, { transfer })` overload — so no worker-lib cast is needed either
 * way.
 */
import { DRAG_HEAT, ForceLayout, RECOOL_TICKS, seedPositions } from "./force.js";
import { nestedLayout, nestedBoundaryDiscs } from "./nested-layout.js";
import { multilevelSeedSteps, buildHierarchy, type SeedProgress } from "./coarsen.js";
import { flattenHierarchyToTopology, lodTreeFromTopology, type LODPositionTree } from "./lod.js";
import { lodFrameStep, makeSpatialLODStream, makeStructureLODStream, recycleSpatialFrame, type LODStream } from "./lod-frame.js";
import { answerCoarsen, refitGeometry } from "./lod-refit.js";
import {
  lodGeometryViews,
  lodGeometryByteLength,
  type CoarsenMessage,
  type LODGeometryRequest,
  type MainToWorker,
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
  /** The per-frame LOD step's state (#343): the coarsening tree to refit, or the spatial tree's stream. */
  lod: LODStream | null;
  /** Copy-mode geometry buffer re-posted each frame (structure only); null in shared mode (worker writes the
   *  SAB directly) and for a spatial stream (its frames carry their own buffers). */
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
/**
 * The LOD stream while the seed runs, before {@link state} holds it: the progress frames (#368) already
 * post spatial trees (#343), whose buffers come back ({@link recycleSpatialFrame}) and whose leaf style and
 * view can change in the meantime.
 */
let seedLOD: LODStream | null = null;

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

/**
 * Post `s`'s positions (and LOD geometry) as a `type` message. `lodFrameId` names the positions for the
 * per-frame LOD step, which builds a spatial tree once per id: the tick, except for the seed's progress
 * frames, which all report tick 0 but each hold new positions (see {@link seedProgressively}).
 */
function postFrame(type: "frame" | "done", s: FrameSource | null = state, lodFrameId = s?.tick ?? 0): void {
  if (!s) return;
  // The per-frame LOD step (#343): refit the coarsening tree in place (cx/cy/extent in the geometry buffer),
  // or rebuild the spatial tree into a frame to transfer (none when nothing moved since the last one).
  const lodFrame = s.lod ? lodFrameStep(s.lod, s.positions, lodFrameId) : null;
  // A spatial stream held back by back-pressure (#343) posts nothing — no frame, and no `done` — until a buffer
  // returns and the frame it skipped is built (`lod-recycle`, which posts a held `done` as a `done`): the tree
  // is what the engine draws and frames, so its positions — and the super-edge rows cut for their fit (#433) —
  // travel with it, not ahead of it.
  if (!lodFrame && s.lod?.kind === "spatial" && s.lod.pending) return;
  const message: ProgressMessage = { type, tick: s.tick };
  if (!s.shared) message.positions = s.positions;
  if (s.lod?.kind === "structure" && s.geomBuffer) message.geometry = new Float32Array(s.geomBuffer); // copy-mode snapshot
  if (lodFrame) {
    message.lodFrame = lodFrame;
    post(message, lodFrame.rows ? [lodFrame.buffer, lodFrame.rows.buffer] : [lodFrame.buffer]);
  } else {
    post(message);
  }
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
  // Each progress frame's positions get their own LOD frame id (#343): −2, −3, … — below a spatial stream's
  // "none built" (−1) and never a tick, so the seed frame (tick 0) after them is rebuilt too.
  let lodFrameId = -1;
  let lastPost = performance.now();
  let lastYield = lastPost;
  let wait = FRAME_MS;
  for (const step of steps) {
    const now = performance.now();
    if (step.atScale && now - lastPost >= wait) {
      step.prolongate();
      if (pendingPin?.positions) writeHeld(frame.positions, pendingPin.ids, pendingPin.positions);
      postFrame("frame", frame, --lodFrameId);
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
  const { nodeCount, source, target, weight, sharedPositions, width, height, iterations, force, coarsen, multilevel, frameEvery, lod, lodSource, lodStyle, lodStyleVersion, lodView } =
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
  const spatial = lod === true && lodSource === "spatial";
  // The spatial tree needs no coarsening; the multilevel seed coarsens for itself when it gets none.
  const hierarchy = lod && !spatial ? buildHierarchy(graph, coarsen) : undefined;
  let lodStream: LODStream | null = null;
  let geomBuffer: ArrayBufferLike | null = null; // copy-mode buffer re-posted each frame
  if (spatial) {
    // The spatial tree (#343) is rebuilt from each frame's positions and travels with the frame, with the
    // super-edge rows of the main thread's view's covers (#433) built here from the edges: nothing to post up
    // front, and the coarsening hierarchy only seeds the layout.
    lodStream = makeSpatialLODStream(nodeCount, lodStyle, lodStyleVersion, { source, target, weight }, lodView);
  } else if (lod && hierarchy) {
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
    lodStream = makeStructureLODStream(lodTreeFromTopology(topology, lodGeometryViews(buffer, topology.size)));
    post({ type: "lod-topology", topology, sharedGeometry });
  }

  // Seed: multilevel coarsening, streamed as it forms (a 300k-node seed takes ~1 s), or a plain disc
  // cold start.
  if (multilevel) {
    const steps = multilevelSeedSteps(graph, { width, height, iterations, force, coarsen }, hierarchy);
    seedLOD = lodStream;
    if (!(await seedProgressively(steps, { positions, lod: lodStream, geomBuffer, shared, tick: 0 }))) return; // stopped
    seedLOD = null;
  } else seedPositions(graph, width, height, { force });

  const layout = new ForceLayout(graph, force);
  // A multilevel seed already has the global arrangement: cool over the budget. A cold disc start
  // still has to untangle, so it keeps full heat (see ForceLayout.run). Either way the loop stops
  // once the layout has converged.
  if (multilevel) layout.cool(iterations);
  else layout.hold(1);
  const s: WorkerState = { layout, positions, lod: lodStream, geomBuffer, shared, frameEvery, runLeft: iterations, dragging: false, tick: 0 };
  state = s;
  seeding = false;

  // Stream the finest-level refinement via the shared loop; it idles when converged (worker stays alive).
  mode = iterations > 0 ? "run" : "idle";
  // A drag that began on a progress frame: hold its nodes from the seed frame on — its positions and the
  // LOD geometry derived from them — and from the first refinement tick.
  const held = pendingPin;
  pendingPin = null;
  if (held) holdNodes(s, held.ids, held.positions);
  postFrame("frame"); // seed frame (tick 0)
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
    case "lod-style": {
      // The layout's own stream (its seed's while it seeds, #368).
      const stream = state?.lod ?? seedLOD;
      if (stream?.kind === "spatial") {
        stream.style = msg.style;
        stream.styleVersion = msg.version;
      }
      return;
    }
    case "lod-view": {
      const stream = state?.lod ?? seedLOD;
      if (stream?.kind === "spatial") stream.view = msg.view;
      return;
    }
    case "lod-recycle": {
      // A frame skipped for back-pressure (#343) is built for the current positions once a buffer is back —
      // mid-seed by the next progress frame or the seed frame, which post the seed's positions as they form.
      // Once the loop has come to rest, the frame it skipped was its `done`.
      const stream = state?.lod ?? seedLOD;
      if (stream?.kind === "spatial" && recycleSpatialFrame(stream, msg.buffer, msg.rows) && state) postFrame(looping ? "frame" : "done");
      return;
    }
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
  }
});
