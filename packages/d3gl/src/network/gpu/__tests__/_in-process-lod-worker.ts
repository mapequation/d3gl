/**
 * The layout worker's coarsening half (#377, #353) in process, for tests: it answers `coarsen` (the seed plan
 * and the LOD topology), `lod-geometry` (the per-frame LOD step: refit, or rebuild the spatial tree, #343),
 * `lod-style` and `lod-recycle` with the real worker code (`lod-refit.ts`, `lod-frame.ts`), and moves buffers
 * the way `postMessage` transfers them (the sender's copy detaches). Messages queue until {@link InProcessLODWorker.flush} — by hand in node tests, or on a
 * timer (`auto`), like a real worker's turn, in browser tests that cannot load a worker (a file that
 * `vi.mock`s a module the worker imports serves the worker the mock, which cannot run there).
 */
import { recycleSpatialFrame, type LODStream } from "../../lod-frame.js";
import { answerCoarsen, answerLODGeometry } from "../../lod-refit.js";
import type { MainToWorker, WorkerToMain } from "../../worker-protocol.js";
import type { LODWorkerPort } from "../lod-relay.js";

export class InProcessLODWorker implements LODWorkerPort {
  onmessage: ((event: MessageEvent<WorkerToMain>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  readonly received: MainToWorker[] = [];
  /** Each refit request's geometry length on arrival (−1: none handed back); the buffers move on after. */
  readonly refitGeometry: number[] = [];
  /** Relayed frames stepped so far (each one per-frame LOD step: a `computeLODPositions` pass, or a spatial rebuild). */
  refits = 0;
  /** What `coarsen` left for the relayed frames: the structure tree to refit, or the spatial stream (#343). */
  stream: LODStream | null = null;
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
      const stream = this.stream;
      if (msg.type === "coarsen") {
        this.stream = answerCoarsen(msg, (message, transfer) => this.reply(message, transfer));
      } else if (msg.type === "lod-geometry" && stream) {
        this.refits++;
        answerLODGeometry(stream, msg, (message, transfer) => this.reply(message, transfer));
      } else if (msg.type === "lod-style" && stream?.kind === "spatial") {
        stream.style = msg.style;
        stream.styleVersion = msg.version;
      } else if (msg.type === "lod-view" && stream?.kind === "spatial") {
        stream.view = msg.view;
      } else if (msg.type === "lod-recycle" && stream?.kind === "spatial") {
        recycleSpatialFrame(stream, msg.buffer, msg.rows);
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
