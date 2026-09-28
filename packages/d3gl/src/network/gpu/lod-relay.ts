/**
 * The GPU layout's LOD tree, built and refit in the layout worker (#377; spec §12.1, decision A, and §15
 * Q7/Q8) — the main thread's half. The worker's half is `lod-refit.ts`.
 *
 * With LOD on, the GPU streams positions far more often than the worker backend does, and before this the
 * main thread built the coarsening tree (~0.2 s at 325k nodes) and refit its geometry on every streamed
 * repaint, an O(tree) pass. The relay moves both into the layout worker, where the worker backend has them:
 *
 * 1. **Coarsen.** At start it posts `{ type: "coarsen" }`. The worker coarsens the graph and transfers the
 *    tree's topology back. Meanwhile the stream harvests straight into `graph.positions`, as with LOD off;
 *    the engine builds no tree, because one is coming.
 * 2. **Adopt.** When the topology arrives the relay builds the tree over its own geometry buffer and has the
 *    worker refit it to the positions on screen. When that returns, the engine adopts the tree
 *    (`onLODTree`) with geometry that matches those positions, and the stream paints it. The stream takes no
 *    harvest in between, so the positions stay the ones the geometry was refit to.
 * 3. **Stream.** From then on each harvest lands in the relay's buffer and goes to the worker
 *    (`{ type: "lod-geometry" }`). It comes back with the tree's geometry refit to it, and the stream puts
 *    both on the graph together and repaints. Both buffers are transferred, both ways, so a frame allocates
 *    nothing and clones nothing. The main thread pays two memcpys per repaint (positions, geometry), the
 *    same copies the worker backend's copy mode makes per frame.
 *
 * The same coarsening also yields the GPU's multilevel seed (#353): with a `seed` request the relay asks the
 * worker for its plan too, and hands it to `seed.onPlan` as soon as it arrives — before the topology, which
 * takes longer to build — or `null` if the worker fails first.
 *
 * `holding` keeps the run's `settled` until the tree is adopted, so the settle handler sees the final
 * positions with their geometry. If the worker fails (it errors, a reply cannot be delivered, or a message
 * cannot be posted), the relay warns once, withdraws the tree (`onLODTree(null)`: the engine builds its own,
 * as before #377), and passes harvests straight through. A frame lost with the worker is reported to the
 * stream, which copies it again. If the very first message (the coarsen request) cannot be posted, the
 * constructor throws instead, so that the caller can report its transport before withdrawing the tree.
 */
import type { CoarsenOptions } from "../coarsen.js";
import type { NetworkGraph } from "../graph.js";
import type { SeedPlan, SeedPlanOptions } from "./seed-plan.js";
import { lodTreeFromTopology, type LODTopology, type LODTree } from "../lod.js";
import {
  lodGeometryByteLength,
  lodGeometryViews,
  type LODGeometryRequest,
  type MainToWorker,
  type WorkerToMain,
} from "../worker-protocol.js";
import type { FrameSink } from "./gpu-stream.js";

/** The part of a `Worker` the relay uses (a `Worker` is one; tests pass an in-process fake). */
export interface LODWorkerPort {
  postMessage(message: MainToWorker, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerToMain>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  terminate(): void;
}

/** A request for the GPU multilevel seed's plan (#353), built from the relay's coarsening. */
export interface SeedRequest {
  readonly options: SeedPlanOptions;
  /** The plan (null: the graph cannot be coarsened), or null when the worker failed before sending it. Called once. */
  readonly onPlan: (plan: SeedPlan | null) => void;
}

/** Where the relay is: building the tree, refitting it for adoption, streaming, or out of service. */
type Phase = "coarsening" | "adopting" | "streaming" | "failed" | "destroyed";

/**
 * The frame the relay holds for the stream: none; a harvest passed straight through (`direct`); a harvest
 * with the worker (`away`) or back from it (`back`); the tree's first geometry (`adopted`); or a harvest the
 * failed worker took with it (`lost`).
 */
type Frame = "none" | "direct" | "away" | "back" | "adopted" | "lost";

/** The LOD tree of a GPU layout, built and refit off the main thread: the stream's {@link FrameSink}. */
export class LODRelay implements FrameSink {
  private readonly port: LODWorkerPort;
  private readonly graph: NetworkGraph;
  private readonly onLODTree: (tree: LODTree | null) => void;
  private phase: Phase = "coarsening";
  private frame: Frame = "none";
  private tree: LODTree | null = null;
  /** The tree's `[cx, cy, extent]`: one view over the buffer its three geometry views share. */
  private treeGeometry: Float32Array | null = null;
  /** The positions buffer, while the main thread holds it (null while it is with the worker). */
  private positions: Float32Array | null = null;
  /** The worker's geometry buffer, held from a reply until the next request hands it back. */
  private geometry: Float32Array | null = null;
  private wake: () => void = () => {};
  /** The seed plan's request, until the plan (or the failure) has been handed over. */
  private seed: SeedRequest | null;

  /**
   * Start the tree on `port`: post the graph's edges for coarsening (copied; the main thread keeps its own).
   * `onLODTree` receives the tree once, with geometry, and `null` if the worker fails later — adopted or not.
   * Throws, with the worker terminated and no callback run, when the coarsen request cannot be posted: the
   * caller reports its transport before it withdraws the tree, and a withdrawal from here would precede that.
   */
  constructor(
    port: LODWorkerPort,
    graph: NetworkGraph,
    coarsen: CoarsenOptions | undefined,
    onLODTree: (tree: LODTree | null) => void,
    seed: SeedRequest | null = null,
  ) {
    this.port = port;
    this.graph = graph;
    this.onLODTree = onLODTree;
    this.seed = seed;
    port.onmessage = (event) => this.receive(event.data);
    port.onerror = () => this.fail("the LOD worker failed");
    port.onmessageerror = () => this.fail("a reply from the LOD worker could not be read");
    const { nodeCount, source, target, weight } = graph;
    try {
      port.postMessage({ type: "coarsen", nodeCount, source, target, weight, coarsen, lod: true, ...(seed ? { seed: seed.options } : {}) }, []);
    } catch (error) {
      this.phase = "destroyed";
      this.release();
      throw error;
    }
  }

  get relays(): boolean {
    return this.phase === "streaming";
  }

  get holding(): boolean {
    return this.phase === "coarsening" || this.phase === "adopting";
  }

  get ready(): boolean {
    return this.frame === "direct" || this.frame === "back" || this.frame === "adopted" || this.frame === "lost";
  }

  target(): Float32Array | null {
    if (this.frame !== "none" || this.phase === "adopting") return null;
    if (this.phase === "streaming") return this.positions;
    return this.graph.positions; // no tree yet, or no worker: straight into the graph
  }

  submit(): void {
    const positions = this.positions;
    if (this.phase !== "streaming" || !positions) {
      this.frame = "direct";
      return;
    }
    const geometry = this.geometry;
    const request: LODGeometryRequest = geometry ? { type: "lod-geometry", positions, geometry } : { type: "lod-geometry", positions };
    this.positions = null;
    this.geometry = null;
    this.frame = "away";
    this.send(request, geometry ? [positions.buffer, geometry.buffer] : [positions.buffer]);
  }

  commit(): boolean {
    const frame = this.frame;
    this.frame = "none";
    if (frame === "lost") return false;
    if (frame === "back" && this.positions && this.geometry && this.treeGeometry) {
      this.graph.positions.set(this.positions);
      this.treeGeometry.set(this.geometry);
    }
    return true;
  }

  listen(wake: () => void): void {
    this.wake = wake;
  }

  destroy(): void {
    if (this.phase === "destroyed") return;
    this.phase = "destroyed";
    this.seed = null; // the run is over: nobody waits for the plan
    this.release();
  }

  // ── The worker's replies ───────────────────────────────────────────────────

  private receive(msg: WorkerToMain): void {
    if (msg.type === "seed-plan") this.handOverSeed(msg.plan);
    else if (msg.type === "lod-topology") this.refitForAdoption(msg.topology);
    else if (msg.type === "lod-geometry") this.returned(msg.positions, msg.geometry);
  }

  /** Hand the seed plan (or its failure, null) to the request, once. */
  private handOverSeed(plan: SeedPlan | null): void {
    const seed = this.seed;
    this.seed = null;
    seed?.onPlan(plan);
  }

  /** The tree's topology arrived: build the tree and refit it to the positions on screen before adopting it. */
  private refitForAdoption(topology: LODTopology): void {
    if (this.phase !== "coarsening") return;
    const buffer = new ArrayBuffer(lodGeometryByteLength(topology.size));
    this.tree = lodTreeFromTopology(topology, lodGeometryViews(buffer, topology.size));
    this.treeGeometry = new Float32Array(buffer);
    // A copy: this buffer becomes the relay's own positions buffer once the worker hands it back.
    const positions = this.graph.positions.slice();
    this.phase = "adopting";
    this.send({ type: "lod-geometry", positions }, [positions.buffer]);
  }

  private returned(positions: Float32Array, geometry: Float32Array): void {
    if (this.phase === "adopting") {
      const tree = this.tree;
      if (!tree || !this.treeGeometry) return;
      this.positions = positions;
      this.geometry = geometry;
      this.treeGeometry.set(geometry);
      this.phase = "streaming";
      this.onLODTree(tree); // the engine adopts it, with geometry for the positions on screen
      this.frame = "adopted"; // the stream paints it
      this.wake();
    } else if (this.phase === "streaming" && this.frame === "away") {
      this.positions = positions;
      this.geometry = geometry;
      this.frame = "back";
      this.wake();
    }
  }

  // ── Failure and teardown ───────────────────────────────────────────────────

  private send(message: MainToWorker, transfer: Transferable[]): void {
    try {
      this.port.postMessage(message, transfer);
    } catch (error) {
      this.fail("a message to the LOD worker failed", error);
    }
  }

  /** The worker is gone: pass harvests straight through, and have the engine build the tree itself. */
  private fail(reason: string, cause?: unknown): void {
    if (this.phase === "failed" || this.phase === "destroyed") return;
    this.phase = "failed";
    if (this.frame === "away") this.frame = "lost";
    this.release();
    const message = `[d3gl] network layout({ backend: 'gpu' }): ${reason}; the LOD tree is built on the main thread instead.`;
    if (cause === undefined) console.warn(message);
    else console.warn(message, cause);
    this.handOverSeed(null); // the layout starts from its disc
    this.onLODTree(null);
    this.wake();
  }

  private release(): void {
    this.port.onmessage = null;
    this.port.onerror = null;
    this.port.onmessageerror = null;
    this.port.terminate();
    this.tree = null;
    this.treeGeometry = null;
    this.positions = null;
    this.geometry = null;
  }
}
