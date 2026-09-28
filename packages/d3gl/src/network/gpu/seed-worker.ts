/**
 * The GPU multilevel seed's coarsening worker when LOD is off (#353, spec §6.4 and §15 Q7): a layout worker
 * coarsens the graph (heavy-edge matching, no layout) and sends back the seed's plan, transferred, while the
 * main thread builds the solver; then it is terminated. With LOD on, the LOD relay's worker builds the plan
 * from the coarsening it does for the tree anyway (`LODRelay`'s `SeedRequest`), so the graph is coarsened once.
 *
 * If the worker fails before the plan arrives (an error, or a reply it cannot deliver), one warning names it
 * and the plan is `null`: the layout starts from its disc.
 */
import type { CoarsenOptions } from "../coarsen.js";
import type { NetworkGraph } from "../graph.js";
import type { WorkerToMain } from "../worker-protocol.js";
import type { LODWorkerPort } from "./lod-relay.js";
import type { SeedPlan, SeedPlanOptions } from "./seed-plan.js";

/** A seed plan being built in a worker: {@link destroy} terminates it (a stopped layout no longer needs it). */
export class SeedWorker {
  private readonly port: LODWorkerPort;
  private onPlan: ((plan: SeedPlan | null) => void) | null;

  /**
   * Post the graph's edges (copied; the main thread keeps its own) for a seed plan. `onPlan` gets it once — or
   * null (a warning names why) if the worker fails first. Throws, with the worker terminated and no callback
   * run, when the request cannot be posted.
   */
  constructor(
    port: LODWorkerPort,
    graph: NetworkGraph,
    coarsen: CoarsenOptions | undefined,
    options: SeedPlanOptions,
    onPlan: (plan: SeedPlan | null) => void,
  ) {
    this.port = port;
    this.onPlan = onPlan;
    port.onmessage = (event: MessageEvent<WorkerToMain>) => {
      if (event.data.type === "seed-plan") this.deliver(event.data.plan);
    };
    port.onerror = () => this.fail("the layout worker building the multilevel seed failed");
    port.onmessageerror = () => this.fail("the multilevel seed from the layout worker could not be read");
    const { nodeCount, source, target, weight } = graph;
    try {
      port.postMessage({ type: "coarsen", nodeCount, source, target, weight, coarsen, lod: false, seed: options }, []);
    } catch (error) {
      this.onPlan = null;
      this.release();
      throw error;
    }
  }

  /** Stop waiting: terminate the worker; the plan is never delivered. */
  destroy(): void {
    this.onPlan = null;
    this.release();
  }

  private deliver(plan: SeedPlan | null): void {
    const onPlan = this.onPlan;
    this.onPlan = null;
    this.release();
    onPlan?.(plan);
  }

  private fail(reason: string): void {
    if (!this.onPlan) return;
    console.warn(`[d3gl] network layout({ backend: 'gpu' }): ${reason}; the layout starts from a disc instead.`);
    this.deliver(null);
  }

  private release(): void {
    this.port.onmessage = null;
    this.port.onerror = null;
    this.port.onmessageerror = null;
    this.port.terminate();
  }
}
