import { describe, it, expect, vi, afterEach } from "vitest";
import { startWorkerLayout } from "../worker-transport.js";
import { buildGraph } from "../graph.js";

/**
 * The worker transport's handle reports the LIVE transport (#297): a worker that fails mid-run falls
 * back to a synchronous main-thread solve, after which `shared` must stop claiming the zero-copy
 * SharedArrayBuffer transport. A stand-in `Worker` (the typed seam: the transport only constructs,
 * posts to, and listens on it) lets the test fire the error.
 */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(): void {}
  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.last = null;
});

describe("startWorkerLayout live transport (#297)", () => {
  it("stops reporting the shared transport once a worker error falls back to a synchronous solve", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("crossOriginIsolated", true); // SharedArrayBuffer transport available
    const g = buildGraph({ nodeCount: 4, source: [0, 1, 2], target: [1, 2, 3] });
    let frames = 0;
    const handle = startWorkerLayout(g, { width: 100, height: 100, iterations: 5, multilevel: false }, () => { frames++; });
    expect(handle.shared).toBe(true);

    const worker = FakeWorker.last;
    expect(worker).not.toBeNull();
    worker?.onerror?.(new Event("error"));

    expect(handle.shared).toBe(false); // no live worker: the positions came from this thread
    expect(worker?.terminated).toBe(true);
    expect(frames).toBe(1); // the synchronous solve painted once
    await handle.settled;
  });

  it("reports the copy transport without cross-origin isolation, before and after an error", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("crossOriginIsolated", false);
    const g = buildGraph({ nodeCount: 4, source: [0, 1, 2], target: [1, 2, 3] });
    const handle = startWorkerLayout(g, { width: 100, height: 100, iterations: 5, multilevel: false }, () => {});
    expect(handle.shared).toBe(false);
    FakeWorker.last?.onerror?.(new Event("error"));
    expect(handle.shared).toBe(false);
    await handle.settled;
  });
});
