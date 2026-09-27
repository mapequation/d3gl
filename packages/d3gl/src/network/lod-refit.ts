/**
 * The LOD worker's half of the GPU layout's LOD refit (#377) — DOM-free and pure, so the layout worker's
 * `{ type: "coarsen" }` / `{ type: "lod-geometry" }` handlers are only glue around it.
 *
 * With LOD on, the GPU layout runs no layout in a worker, but it still needs one for the LOD tree: the
 * worker coarsens the graph into the tree's topology (as the worker backend does for its multilevel seed)
 * and hands it to the main thread, then refits the tree's position geometry (`cx`/`cy`/`extent`) to each
 * position snapshot the GPU harvests — the O(tree) pass the worker backend runs per frame, off the main
 * thread in both cases. The main thread never coarsens and never refits.
 *
 * Each relayed frame runs the worker backend's own per-frame step, {@link lodFrameStep} (#343): rebuild if
 * spatial, else refit. With the spatial source the worker coarsens nothing for the tree (only for the seed's
 * plan, when asked): each frame rebuilds the Morton tree for the harvested positions and transfers it — with
 * the super-edge rows of the glyphs the main thread's view keeps, summed from the edges (#433) — and a frame id
 * it already built is skipped, so the rebuilds stop once the layout has converged.
 */
import { buildHierarchy, type CoarseLevel, type CoarsenOptions, type Hierarchy } from "./coarsen.js";
import { flattenHierarchyToTopology, type LODTopology } from "./lod.js";
import { lodFrameStep, makeSpatialLODStream, makeStructureLODStream, type LODStream, type StructureStreamTree } from "./lod-frame.js";
import { lodGeometryByteLength, lodGeometryViews, type CoarsenMessage, type LODGeometryRequest, type WorkerToMain } from "./worker-protocol.js";
import { coarseSeedPlan, seedPlanTransferables } from "./gpu/seed-plan.js";

/** How the worker's handlers reply: a message and the buffers it transfers. */
export type WorkerSend = (message: WorkerToMain, transfer: Transferable[]) => void;

/**
 * Coarsen `graph` into the LOD tree's topology — the tree the worker backend streams, super-edges included
 * — and the worker's own position tree for refitting it. The position tree holds **copies** of the level
 * layout and the children CSR, so every buffer of `topology` can be transferred to the main thread
 * ({@link topologyTransferables}) with no clone on either side. Its geometry is bound per refit.
 */
export function coarsenForRefit(
  graph: CoarseLevel,
  coarsen?: CoarsenOptions,
  hierarchy: Hierarchy = buildHierarchy(graph, coarsen),
): { topology: LODTopology; tree: StructureStreamTree } {
  const topology = flattenHierarchyToTopology(hierarchy, graph.nodeCount, graph);
  const { size } = topology;
  const tree: StructureStreamTree = {
    size,
    leafCount: topology.leafCount,
    levelCount: topology.levelCount,
    levelOffset: topology.levelOffset.slice(),
    childOffset: topology.childOffset.slice(),
    children: topology.children.slice(),
    count: new Uint32Array(size),
    cx: new Float32Array(0),
    cy: new Float32Array(0),
    extent: new Float32Array(0),
    clearZoom: new Float32Array(0),
    radius: new Float32Array(0),
    leafBranching: 0,
  };
  return { topology, tree };
}

/**
 * Bind `tree`'s position geometry (`cx`/`cy`/`extent`) to `buffer` ({@link lodGeometryViews}), where the next
 * refit writes it, and return the whole geometry as one view over `buffer`. Allocates only the views.
 */
function bindGeometry(tree: StructureStreamTree, buffer: ArrayBufferLike): Float32Array {
  const views = lodGeometryViews(buffer, tree.size);
  tree.cx = views.cx;
  tree.cy = views.cy;
  tree.extent = views.extent;
  tree.clearZoom = views.clearZoom;
  return new Float32Array(buffer, 0, 4 * tree.size);
}

/**
 * The layout worker's answer to one relayed frame ({@link LODGeometryRequest}): the per-frame LOD step
 * ({@link lodFrameStep}) for the positions it carries, then `send` them back with its result. A structure
 * stream refits the tree into the geometry buffer the request handed back (the worker allocates one on the
 * first request) — the same pass, and the same values, as the worker backend's per-frame
 * `computeLODPositions` — and returns it. A spatial stream rebuilds the Morton tree into a packed frame and
 * transfers it, or returns none for a frame id it already built. Either way the positions go back.
 */
export function answerLODGeometry(stream: LODStream, msg: LODGeometryRequest, send: WorkerSend): void {
  const { positions } = msg;
  if (stream.kind === "structure") {
    const geometry = bindGeometry(stream.tree, msg.geometry?.buffer ?? new ArrayBuffer(lodGeometryByteLength(stream.tree.size)));
    // No crowding computed here (#426: the relay gets no leaf style for a structure tree) — never a zeroed 0,
    // which would read as "every member clears"; the main thread computes it once the layout settles.
    if (!stream.style?.crowding) stream.tree.clearZoom.fill(Infinity);
    lodFrameStep(stream, positions, msg.frame);
    send({ type: "lod-geometry", positions, geometry }, [positions.buffer, geometry.buffer]);
    return;
  }
  const lodFrame = lodFrameStep(stream, positions, msg.frame);
  if (!lodFrame) send({ type: "lod-geometry", positions }, [positions.buffer]);
  else if (lodFrame.rows) send({ type: "lod-geometry", positions, lodFrame }, [positions.buffer, lodFrame.buffer, lodFrame.rows.buffer]);
  else send({ type: "lod-geometry", positions, lodFrame }, [positions.buffer, lodFrame.buffer]);
}

/** Every buffer behind `topology`'s typed arrays, each once: the transfer list that moves it to the main thread. */
export function topologyTransferables(topology: LODTopology): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const value of Object.values(topology)) {
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
  }
  return [...buffers];
}

/**
 * The layout worker's answer to a {@link CoarsenMessage}: coarsen once, then `send` the GPU seed's plan the
 * moment it is built (when `seed` was asked for, #353) — before the slower LOD topology, so the GPU seed starts
 * early — and then the LOD tree's topology (when `lod` was, #377). Every reply's buffers go in its transfer
 * list. Returns the stream each relayed frame steps ({@link answerLODGeometry}): the structure tree to refit,
 * or, for `lodSource: "spatial"` (#343), a spatial stream — for which nothing is coarsened unless the seed
 * needs it, and no topology is sent. Null without `lod`.
 */
export function answerCoarsen(msg: CoarsenMessage, send: WorkerSend): LODStream | null {
  const spatial = msg.lod && msg.lodSource === "spatial";
  // The spatial tree is built from positions alone: coarsen only for the seed's plan or the structure tree.
  const hierarchy = msg.seed || (msg.lod && !spatial) ? buildHierarchy(msg, msg.coarsen) : null;
  if (msg.seed && hierarchy) {
    const plan = coarseSeedPlan(msg, hierarchy, msg.seed);
    send({ type: "seed-plan", plan }, plan ? seedPlanTransferables(plan) : []);
  }
  if (!msg.lod) return null;
  // The spatial stream keeps the edges for its trees' super-edge rows (#433).
  if (spatial) return makeSpatialLODStream(msg.nodeCount, msg.lodStyle, msg.lodStyleVersion, msg, msg.lodView);
  const { topology, tree } = coarsenForRefit(msg, msg.coarsen, hierarchy ?? undefined);
  send({ type: "lod-topology", topology }, topologyTransferables(topology));
  return makeStructureLODStream(tree);
}
