import { describe, it, expect, vi, afterEach } from "vitest";
import { flattenModuleLinks, flattenModuleRecords, type ModuleLink, type ModuleNode } from "../modules.js";
import { buildModuleTopology } from "../module-topology.js";
import { buildGraph } from "../graph.js";
import { topologyBuffers, type MainToWorker } from "../worker-protocol.js";
import { buildModuleTopologyOffThread, deferredLayoutHandle, type WorkerLayoutHandle } from "../worker-transport.js";

/** A ragged two-module map (as in network-hierarchy.browser.test.ts) with module links at two depths. */
const RECORDS: ModuleNode[] = [
  { id: 0, path: [1, 1, 1] }, { id: 1, path: [1, 1, 2] }, { id: 2, path: [1, 2, 1] }, { id: 3, path: [1, 2, 2] },
  { id: 4, path: [2, 1] }, { id: 5, path: [2, 2] }, { id: 6, path: [2, 3] }, { id: 7, path: [2, 4] },
];
const LINKS: ModuleLink[] = [
  { source: [1], target: [2], flow: 0.5 },
  { source: [1, 1], target: [1, 2], flow: 0.25 },
];
const graph = () => buildGraph({ nodeCount: 8, source: [0, 2, 0, 4, 6, 4, 5, 3], target: [1, 3, 2, 5, 7, 6, 7, 4], directed: true });

/** Stands in for `Worker`: records what the job does with it, and lets a test fire its events. */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  posted: { message: MainToWorker; transfer: ArrayBuffer[] }[] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: MainToWorker, transfer: ArrayBuffer[]): void {
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.last = null;
});

describe("topologyBuffers (#428)", () => {
  // The worker transfers a module tree's buffers, so the main thread receives it without a copy. The list
  // is written by hand: a typed array added to LODTopology but not to the list would be cloned silently.
  it("covers the buffer of every typed array on a module tree's topology", () => {
    const topo = buildModuleTopology(8, flattenModuleRecords(8, RECORDS), graph(), flattenModuleLinks(LINKS));
    expect(topo.superEdgeOffset).toBeDefined(); // the fixture carries super-edges…
    expect(topo.moduleLinkOffset).toBeDefined(); // …and module-link rows (#329)
    const transferred = new Set<ArrayBufferLike>(topologyBuffers(topo));
    const views: ArrayBufferView[] = [];
    for (const value of Object.values(topo)) if (ArrayBuffer.isView(value)) views.push(value);
    expect(views.length).toBeGreaterThanOrEqual(20);
    for (const view of views) expect(transferred.has(view.buffer)).toBe(true);
  });
});

describe("buildModuleTopologyOffThread (#428)", () => {
  it("returns null without Web Workers, and never flattens the records", () => {
    vi.stubGlobal("Worker", undefined);
    const input = vi.fn(() => ({ records: flattenModuleRecords(8, RECORDS) }));
    expect(buildModuleTopologyOffThread(8, input, graph())).toBeNull();
    expect(input).not.toHaveBeenCalled();
  });

  it("transfers the flat records and links, and copies the edges", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const records = flattenModuleRecords(8, RECORDS);
    const links = flattenModuleLinks(LINKS);
    const g = graph();
    expect(buildModuleTopologyOffThread(8, () => ({ records, links }), g)).not.toBeNull();
    const [post] = FakeWorker.last?.posted ?? [];
    expect(post?.message).toMatchObject({ type: "build-module-tree", nodeCount: 8, source: g.source, target: g.target, weight: g.weight });
    const transfer = new Set(post?.transfer);
    for (const view of [records.id, records.offset, records.entries, links.sourceOffset, links.source, links.targetOffset, links.target, links.flow]) {
      expect(transfer.has(view.buffer)).toBe(true);
    }
    for (const edges of [g.source, g.target, g.weight]) expect(transfer.has(edges.buffer)).toBe(false);
  });

  it("falls back to the caller when the tree's message cannot be deserialized", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const job = buildModuleTopologyOffThread(8, () => ({ records: flattenModuleRecords(8, RECORDS) }), graph());
    FakeWorker.last?.onmessageerror?.(new MessageEvent("messageerror"));
    expect(await job?.topology).toBeNull();
    expect(FakeWorker.last?.terminated).toBe(true);
  });

  it("falls back to the caller when the worker fails", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const job = buildModuleTopologyOffThread(8, () => ({ records: flattenModuleRecords(8, RECORDS) }), graph());
    FakeWorker.last?.onerror?.(new Event("error"));
    expect(await job?.topology).toBeNull();
    expect(FakeWorker.last?.terminated).toBe(true);
  });

  it("leaves no worker behind when the records are invalid", () => {
    vi.stubGlobal("Worker", FakeWorker);
    expect(() => buildModuleTopologyOffThread(8, () => ({ records: flattenModuleRecords(8, RECORDS.slice(1)) }), graph())).toThrow(/no record for node id 0/);
    expect(FakeWorker.last?.terminated).toBe(true);
    expect(FakeWorker.last?.posted).toEqual([]);
  });
});

describe("deferredLayoutHandle (#428)", () => {
  const run = (settled: Promise<void>): WorkerLayoutHandle => ({ shared: false, settled, stop() {}, pin() {}, unpin() {} });

  it("settles with the run it starts", async () => {
    let finish: () => void = () => {};
    const handle = deferredLayoutHandle(Promise.resolve(1), () => run(new Promise<void>((resolve) => (finish = resolve))));
    let settled = false;
    void handle.settled.then(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await handle.settled;
    expect(settled).toBe(true);
  });

  it("rejects when the start throws, instead of never settling", async () => {
    const handle = deferredLayoutHandle(Promise.resolve(1), () => {
      throw new Error("no start");
    });
    await expect(handle.settled).rejects.toThrow("no start");
  });

  it("rejects when the run it started fails", async () => {
    const handle = deferredLayoutHandle(Promise.resolve(1), () => run(Promise.reject(new Error("run failed"))));
    await expect(handle.settled).rejects.toThrow("run failed");
  });

  // Network.layoutTransport reads the handle: once the run is live it must report the run's transport
  // (a GPU seed that waited for its tree is still a GPU run), not a fixed copy-mode default.
  it("reports the transport of the run it starts", async () => {
    let started: () => void = () => {};
    const live = new Promise<void>((resolve) => (started = resolve));
    const handle = deferredLayoutHandle(Promise.resolve(1), () => {
      started();
      return { ...run(new Promise<void>(() => {})), shared: true, transport: "gpu" };
    });
    expect([handle.shared, handle.transport, handle.mainThread]).toEqual([false, undefined, undefined]);
    await live;
    expect([handle.shared, handle.transport]).toEqual([true, "gpu"]);
    const onMain = deferredLayoutHandle(Promise.resolve(1), () => ({ ...run(Promise.resolve()), mainThread: true }));
    await onMain.settled;
    expect(onMain.mainThread).toBe(true);
  });

  it("settles at once when the start declines, or when stopped before it", async () => {
    await deferredLayoutHandle(Promise.resolve(1), () => null).settled;
    const start = vi.fn(() => null);
    const stopped = deferredLayoutHandle(new Promise<number>(() => {}), start);
    stopped.stop();
    await stopped.settled;
    expect(start).not.toHaveBeenCalled();
  });
});
