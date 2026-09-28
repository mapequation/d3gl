/**
 * The layout worker's LOD half (#377) in process, for tests: it answers `coarsen` and `lod-geometry` with the
 * real worker code (`lod-refit.ts`), and moves buffers the way `postMessage` transfers them (the sender's
 * copy detaches). Messages queue until {@link InProcessLODWorker.flush} — by hand in node tests, or on a
 * timer (`auto`), like a real worker's turn, in browser tests that cannot load a worker (a file that
 * `vi.mock`s a module the worker imports serves the worker the mock, which cannot run there).
 */
import type { LODPositionTree } from "../../lod.js";
import { coarsenForRefit, refitGeometry, topologyTransferables } from "../../lod-refit.js";
import { lodGeometryByteLength, type MainToWorker, type WorkerToMain } from "../../worker-protocol.js";
import type { LODWorkerPort } from "../lod-relay.js";

export class InProcessLODWorker implements LODWorkerPort {
  onmessage: ((event: MessageEvent<WorkerToMain>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  readonly received: MainToWorker[] = [];
  /** Each refit request's geometry length on arrival (−1: none handed back); the buffers move on after. */
  readonly refitGeometry: number[] = [];
  /** Refits run so far (each one `computeLODPositions` pass). */
  refits = 0;
  private tree: LODPositionTree | null = null;
  private readonly queue: MainToWorker[] = [];
  private readonly auto: boolean;
  private scheduled = false;

  constructor(opts: { auto?: boolean } = {}) {
    this.auto = opts.auto ?? false;
  }

  postMessage(message: MainToWorker, transfer: Transferable[]): void {
    const copy = structuredClone(message, { transfer }); // detaches what the sender transferred, as postMessage does
    this.received.push(copy);
    if (copy.type === "lod-geometry") this.refitGeometry.push(copy.geometry?.length ?? -1);
    this.queue.push(copy);
    if (this.auto && !this.scheduled) {
      this.scheduled = true;
      setTimeout(() => {
        this.scheduled = false;
        this.flush();
      }, 0);
    }
  }

  /** The worker's turn: handle every queued message (replies may queue more, e.g. the adoption refit). */
  flush(): void {
    for (let msg = this.queue.shift(); msg; msg = this.queue.shift()) {
      if (this.terminated) return;
      if (msg.type === "coarsen") {
        const { topology, tree } = coarsenForRefit(msg, msg.coarsen);
        this.tree = tree;
        this.reply({ type: "lod-topology", topology }, topologyTransferables(topology));
      } else if (msg.type === "lod-geometry" && this.tree) {
        const buffer = msg.geometry?.buffer ?? new ArrayBuffer(lodGeometryByteLength(this.tree.size));
        const geometry = refitGeometry(this.tree, msg.positions, buffer);
        this.refits++;
        this.reply({ type: "lod-geometry", positions: msg.positions, geometry }, [msg.positions.buffer, geometry.buffer]);
      }
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  private reply(message: WorkerToMain, transfer: Transferable[]): void {
    const data = structuredClone(message, { transfer });
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}
