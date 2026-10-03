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
 * **The spatial source** (#343) needs no tree up front: the worker rebuilds the Morton tree for every relayed
 * frame with the worker backend's own per-frame step (`lodFrameStep`), so the relay relays from the first
 * harvest. Each reply carries the positions and the tree rebuilt for them (none for a frame id the worker
 * already built: the layout converged), and the commit hands that tree to the engine (`onLODTree(tree,
 * streamed)`, the worker backend's O(1) adoption) together with the positions. The engine releases each tree
 * once no repaint draws it, which sends its buffer back to the worker for reuse; while `MAX_OUTSTANDING` trees
 * are unreleased the relay takes no harvest, so the worker never skips a frame for back-pressure (it would
 * have no positions to build the skipped one from later). The worker coarsens only for a seed's plan.
 *
 * **Started before its stream** (#385): a GPU layout starts coarsening while its programs are still compiling
 * (frames, when the shader cache is cold), so the relay is built *unarmed*. It then hands the seed plan over as
 * usual (the transport buffers it) but keeps the tree's topology, and a worker failure's withdrawal and warning,
 * to itself until {@link arm} — once the stream exists and the run has reported its transport, so the engine never
 * sees a tree (or `null`) before them, and the page is told the tree is built on the main thread only when it
 * will be. A relay destroyed unarmed (the run fell back to the worker, whose own worker streams the tree) never
 * calls `onLODTree` and never warns. (A spatial tree reaches the engine only with a harvested frame, so after
 * {@link arm} anyway.)
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
import { MAX_OUTSTANDING, lodTreeFromSpatialFrame, type LeafStyle, type LODView, type SpatialLODFrame } from "../lod-frame.js";
import type { StreamedLODTree } from "../worker-transport.js";
import {
  lodGeometryByteLength,
  lodGeometryViews,
  type LODGeometryMessage,
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

/** What the relay's worker streams: the coarsening tree (refit per frame), or the spatial tree (rebuilt, #343). */
export interface LODRelayOptions {
  coarsen?: CoarsenOptions;
  /** `"structure"` (default) or `"spatial"`. */
  source?: "structure" | "spatial";
  /** The leaf style a spatial tree aggregates per rebuild, and its version (see {@link LODRelay.setStyle}). */
  style?: LeafStyle;
  styleVersion?: number;
  /** The view whose kept glyphs' super-edge rows each rebuilt spatial tree carries (#433; see {@link LODRelay.setView}). */
  view?: LODView;
}

/** Called with the tree once (structure) or with every rebuilt tree and its streamed handle (spatial), and
 *  with `null` when the worker fails. */
export type OnLODTree = (tree: LODTree | null, streamed?: StreamedLODTree) => void;

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
  private readonly onLODTree: OnLODTree;
  /** Whether the worker rebuilds the spatial tree per frame (#343) instead of refitting a coarsening tree. */
  private readonly spatial: boolean;
  private phase: Phase;
  private frame: Frame = "none";
  private tree: LODTree | null = null;
  /** The tree's `[cx, cy, extent]`: one view over the buffer its three geometry views share. */
  private treeGeometry: Float32Array | null = null;
  /** The positions buffer, while the main thread holds it (null while it is with the worker). */
  private positions: Float32Array | null = null;
  /** The worker's geometry buffer, held from a reply until the next request hands it back. */
  private geometry: Float32Array | null = null;
  /** The spatial tree the worker rebuilt for the frame that is back, until the commit hands it over (#343). */
  private spatialFrame: SpatialLODFrame | null = null;
  /** Spatial trees handed to the engine and not released yet (#343). */
  private outstanding = 0;
  /** The ticks of the last harvest submitted: the frame id of the adoption refit's positions. */
  private ticks = -1;
  private wake: () => void = () => {};
  /** The seed plan's request, until the plan (or the failure) has been handed over. */
  private seed: SeedRequest | null;
  /** Whether the run exists (#385): until then the tree, or its withdrawal, waits here. */
  private armed: boolean;
  /** A topology that arrived before {@link arm}. */
  private pending: LODTopology | null = null;
  /** The warning of a worker that failed before {@link arm}: printed there, dropped by {@link destroy}. */
  private failure: { readonly message: string; readonly cause?: unknown } | null = null;

  /**
   * Start the tree on `port`: post the graph's edges for coarsening (copied; the main thread keeps its own).
   * `onLODTree` receives the tree once, with geometry — or, for the spatial source, every rebuilt tree with its
   * streamed handle — and `null` if the worker fails later, adopted or not. Throws, with the worker terminated
   * and no callback run, when the coarsen request cannot be posted: the caller reports its transport before it
   * withdraws the tree, and a withdrawal from here would precede that. `armed: false` starts it ahead of its
   * run: nothing reaches `onLODTree` before {@link arm}.
   */
  constructor(
    port: LODWorkerPort,
    graph: NetworkGraph,
    options: LODRelayOptions,
    onLODTree: OnLODTree,
    seed: SeedRequest | null = null,
    armed = true,
  ) {
    this.port = port;
    this.graph = graph;
    this.onLODTree = onLODTree;
    this.seed = seed;
    this.armed = armed;
    this.spatial = options.source === "spatial";
    // The spatial tree needs no coarsening: every harvest goes to the worker, which rebuilds it (#343).
    this.phase = this.spatial ? "streaming" : "coarsening";
    if (this.spatial) this.positions = new Float32Array(graph.positions.length);
    port.onmessage = (event) => this.receive(event.data);
    port.onerror = () => this.fail("the LOD worker failed");
    port.onmessageerror = () => this.fail("a reply from the LOD worker could not be read");
    const { nodeCount } = graph;
    const spatial = this.spatial
      ? {
          lodSource: "spatial" as const,
          ...(options.style ? { lodStyle: options.style, lodStyleVersion: options.styleVersion } : {}),
          ...(options.view ? { lodView: options.view } : {}),
        }
      : {};
    // The edges are cloned into the worker (12 B per edge, synchronously here): it coarsens them for the
    // structure tree or a seed's plan, and sums them into a spatial tree's super-edge rows (#433).
    try {
      port.postMessage(
        {
          type: "coarsen",
          nodeCount,
          source: graph.source,
          target: graph.target,
          weight: graph.weight,
          coarsen: options.coarsen,
          lod: true,
          ...spatial,
          ...(seed ? { seed: seed.options } : {}),
        },
        [],
      );
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
    if (this.phase === "streaming") {
      // The engine still holds MAX_OUTSTANDING spatial trees (#343): wait for one to come back before the next.
      if (this.spatial && this.outstanding >= MAX_OUTSTANDING) return null;
      return this.positions;
    }
    return this.graph.positions; // no tree yet, or no worker: straight into the graph
  }

  submit(ticks: number, final = false): void {
    this.ticks = ticks;
    const positions = this.positions;
    if (this.phase !== "streaming" || !positions) {
      this.frame = "direct";
      return;
    }
    const geometry = this.geometry;
    const request: LODGeometryRequest = geometry ? { type: "lod-geometry", positions, frame: ticks, geometry } : { type: "lod-geometry", positions, frame: ticks };
    if (final) request.settled = true; // the settled frame: the worker computes its crowding (#426)
    this.positions = null;
    this.geometry = null;
    this.frame = "away";
    this.send(request, geometry ? [positions.buffer, geometry.buffer] : [positions.buffer]);
  }

  commit(): boolean {
    const frame = this.frame;
    this.frame = "none";
    if (frame === "lost") return false;
    if (frame === "back" && this.positions) {
      if (this.spatial) {
        this.graph.positions.set(this.positions);
        const rebuilt = this.spatialFrame;
        this.spatialFrame = null;
        if (rebuilt) this.handOver(rebuilt);
      } else if (this.geometry && this.treeGeometry) {
        this.graph.positions.set(this.positions);
        this.treeGeometry.set(this.geometry);
      }
    }
    return true;
  }

  /**
   * A new leaf style for the spatial tree's rebuilds (#343, after `style()`): the frames the worker builds from
   * here on aggregate it and carry `version`. No-op for the structure source (the engine aggregates its style).
   */
  setStyle(style: LeafStyle, version: number): void {
    if (this.spatial && this.phase === "streaming") this.send({ type: "lod-style", style, version }, []);
  }

  /** The main thread's new view (#433): later spatial trees carry the super-edge rows of the glyphs it keeps. */
  setView(view: LODView): void {
    if (this.spatial && this.phase === "streaming") this.send({ type: "lod-view", view }, []);
  }

  listen(wake: () => void): void {
    this.wake = wake;
  }

  /**
   * The run exists and has reported its transport (#385): adopt a topology that arrived before (refit to the
   * positions on screen now), or, if the worker already failed, warn and withdraw the tree. Idempotent.
   */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    const pending = this.pending;
    this.pending = null;
    const failure = this.failure;
    this.failure = null;
    if (this.phase === "failed") {
      if (failure) warn(failure.message, failure.cause);
      this.onLODTree(null);
      this.wake();
    } else if (pending) {
      this.refitForAdoption(pending);
    }
  }

  destroy(): void {
    if (this.phase === "destroyed") return;
    this.phase = "destroyed";
    this.seed = null; // the run is over: nobody waits for the plan
    this.failure = null; // destroyed unarmed: the run fell back, and its worker builds the tree
    this.release();
  }

  // ── The worker's replies ───────────────────────────────────────────────────

  private receive(msg: WorkerToMain): void {
    if (msg.type === "seed-plan") this.handOverSeed(msg.plan);
    else if (msg.type === "lod-topology") this.refitForAdoption(msg.topology);
    else if (msg.type === "lod-geometry") this.returned(msg);
  }

  /**
   * Hand a rebuilt spatial tree to the engine (#343) — O(1): views over its buffer — with a `release` that
   * sends the buffer back to the worker once no repaint draws the tree (a no-op once the worker is gone).
   */
  private handOver(rebuilt: SpatialLODFrame): void {
    this.outstanding++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const waited = this.outstanding >= MAX_OUTSTANDING;
      this.outstanding--;
      if (this.phase !== "streaming") return;
      const rows = rebuilt.rows?.buffer;
      this.send({ type: "lod-recycle", buffer: rebuilt.buffer, rows }, rows ? [rebuilt.buffer, rows] : [rebuilt.buffer]);
      if (waited) this.wake(); // the stream can harvest again
    };
    this.onLODTree(lodTreeFromSpatialFrame(rebuilt), { header: rebuilt.header, release });
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
    if (!this.armed) {
      this.pending = topology; // adopted at arm(), refit to the positions on screen then
      return;
    }
    const buffer = new ArrayBuffer(lodGeometryByteLength(topology.size));
    this.tree = lodTreeFromTopology(topology, lodGeometryViews(buffer, topology.size));
    this.treeGeometry = new Float32Array(buffer);
    // A copy: this buffer becomes the relay's own positions buffer once the worker hands it back.
    const positions = this.graph.positions.slice();
    this.phase = "adopting";
    this.send({ type: "lod-geometry", positions, frame: this.ticks }, [positions.buffer]);
  }

  private returned(msg: LODGeometryMessage): void {
    const { positions, geometry } = msg;
    if (this.phase === "adopting") {
      const tree = this.tree;
      if (!tree || !this.treeGeometry || !geometry) return;
      this.positions = positions;
      this.geometry = geometry;
      this.treeGeometry.set(geometry);
      this.phase = "streaming";
      this.onLODTree(tree); // the engine adopts it, with geometry for the positions on screen
      this.frame = "adopted"; // the stream paints it
      this.wake();
    } else if (this.phase === "streaming" && this.frame === "away") {
      this.positions = positions;
      if (this.spatial) this.spatialFrame = msg.lodFrame ?? null; // none: a frame id already built (converged)
      else this.geometry = geometry ?? null;
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

  /**
   * The worker is gone: pass harvests straight through, and have the engine build the tree itself. Unarmed, the
   * warning and the withdrawal wait for {@link arm}: the run may still fall back to the worker backend.
   */
  private fail(reason: string, cause?: unknown): void {
    if (this.phase === "failed" || this.phase === "destroyed") return;
    this.phase = "failed";
    if (this.frame === "away") this.frame = "lost";
    this.release();
    const message = `[d3gl] network layout({ backend: 'gpu' }): ${reason}; the LOD tree is built on the main thread instead.`;
    if (!this.armed) {
      this.failure = cause === undefined ? { message } : { message, cause };
      this.handOverSeed(null); // the layout starts from its disc
      return; // warned and withdrawn at arm(), after the run reported its transport
    }
    warn(message, cause);
    this.handOverSeed(null); // the layout starts from its disc
    this.onLODTree(null);
    this.wake();
  }

  private release(): void {
    this.port.onmessage = null;
    this.port.onerror = null;
    this.port.onmessageerror = null;
    this.port.terminate();
    this.pending = null;
    this.tree = null;
    this.treeGeometry = null;
    this.positions = null;
    this.geometry = null;
    this.spatialFrame = null;
  }
}

/** `console.warn` with the cause, when there is one. */
function warn(message: string, cause: unknown): void {
  if (cause === undefined) console.warn(message);
  else console.warn(message, cause);
}
