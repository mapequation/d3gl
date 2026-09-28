/**
 * The LOD worker's half of the GPU layout's LOD refit (#377) — DOM-free and pure, so the layout worker's
 * `{ type: "coarsen" }` / `{ type: "lod-geometry" }` handlers are only glue around it.
 *
 * With LOD on, the GPU layout runs no layout in a worker, but it still needs one for the LOD tree: the
 * worker coarsens the graph into the tree's topology (as the worker backend does for its multilevel seed)
 * and hands it to the main thread, then refits the tree's position geometry (`cx`/`cy`/`extent`) to each
 * position snapshot the GPU harvests — the O(tree) pass the worker backend runs per frame, off the main
 * thread in both cases. The main thread never coarsens and never refits.
 */
import { buildHierarchy, type CoarseLevel, type CoarsenOptions } from "./coarsen.js";
import { computeLODPositions, flattenHierarchyToTopology, type LODPositionTree, type LODTopology } from "./lod.js";
import { lodGeometryViews } from "./worker-protocol.js";

/**
 * Coarsen `graph` into the LOD tree's topology — the tree the worker backend streams, super-edges included
 * — and the worker's own position tree for refitting it. The position tree holds **copies** of the level
 * layout and the children CSR, so every buffer of `topology` can be transferred to the main thread
 * ({@link topologyTransferables}) with no clone on either side. Its geometry is bound per refit.
 */
export function coarsenForRefit(graph: CoarseLevel, coarsen?: CoarsenOptions): { topology: LODTopology; tree: LODPositionTree } {
  const topology = flattenHierarchyToTopology(buildHierarchy(graph, coarsen), graph.nodeCount, graph);
  const { size } = topology;
  const tree: LODPositionTree = {
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
  };
  return { topology, tree };
}

/**
 * Refit `tree`'s position geometry to `positions` (interleaved `[x, y, …]`), written into `buffer` as
 * `[cx, cy, extent]` ({@link lodGeometryViews}). The same pass, and the same values, as the worker backend's
 * per-frame {@link computeLODPositions}. Returns the whole geometry as one view over `buffer`; allocates only
 * the views.
 */
export function refitGeometry(tree: LODPositionTree, positions: ArrayLike<number>, buffer: ArrayBufferLike): Float32Array {
  const views = lodGeometryViews(buffer, tree.size);
  tree.cx = views.cx;
  tree.cy = views.cy;
  tree.extent = views.extent;
  computeLODPositions(tree, positions);
  return new Float32Array(buffer, 0, 3 * tree.size);
}

/** Every buffer behind `topology`'s typed arrays, each once: the transfer list that moves it to the main thread. */
export function topologyTransferables(topology: LODTopology): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const value of Object.values(topology)) {
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
  }
  return [...buffers];
}
