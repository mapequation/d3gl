import { describe, it, expect, vi, afterEach } from "vitest";
import { startWorkerLayout } from "../worker-transport.js";
import { buildGraph } from "../graph.js";
import { ForceLayout } from "../force.js";
import type { MainToWorker } from "../worker-protocol.js";

/**
 * The worker transport's handle reports the LIVE transport (#297): a worker that fails mid-run falls
 * back to a synchronous main-thread solve, after which `shared` must stop claiming the zero-copy
 * SharedArrayBuffer transport. A stand-in `Worker` (the typed seam: the transport only constructs,
 * posts to, and listens on it) lets the test fire the error and read what was posted.
 */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  terminated = false;
  readonly posted: MainToWorker[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: MainToWorker): void {
    this.posted.push(structuredClone(message)); // a real worker receives a clone taken at post time
  }
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

/** A path with preset positions: a layout already in progress, which a warm start continues. */
function laidOutPath() {
  const g = buildGraph({ nodeCount: 6, source: [0, 1, 2, 3, 4], target: [1, 2, 3, 4, 5] });
  for (let i = 0; i < 6; i++) {
    g.positions[i * 2] = 100 + 40 * i;
    g.positions[i * 2 + 1] = 80 + (i % 2) * 30;
  }
  return g;
}

/** A warm start's ticks computed here, as the reference: the handed-over schedule, until converged. */
function warmReference(iterations: number, heat: number, decaying: boolean): Float32Array {
  const g = laidOutPath();
  const layout = new ForceLayout(g);
  if (decaying) layout.cool(iterations, heat);
  else layout.hold(heat);
  for (let t = 0; t < iterations; t++) {
    layout.tick();
    if (layout.converged) break;
  }
  return g.positions;
}

/** The `start` message a fake worker received. */
function startMessage(worker: FakeWorker | null) {
  const start = worker?.posted.find((m) => m.type === "start");
  if (!start || start.type !== "start") throw new Error("no start message was posted");
  return start;
}

describe("startWorkerLayout warm start (#311)", () => {
  it("copy mode: posts the positions it continues from and the heat schedule, and seeds nothing", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("crossOriginIsolated", false);
    const g = laidOutPath();
    const before = g.positions.slice();
    const handle = startWorkerLayout(g, { width: 100, height: 100, iterations: 7, warm: { heat: 0.4, decaying: true } }, () => {});
    expect(g.positions).toEqual(before); // no seed disc painted over the layout in progress
    const start = startMessage(FakeWorker.last);
    expect(start.iterations).toBe(7); // the ticks it had left
    expect(start.warm?.heat).toBe(0.4);
    expect(start.warm?.decaying).toBe(true);
    expect(start.warm?.positions).toEqual(before);
    handle.stop();
    await handle.settled;
  });

  it("shared mode: the positions ride in the shared buffer, not in the message", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("crossOriginIsolated", true);
    const g = laidOutPath();
    const before = g.positions.slice();
    const handle = startWorkerLayout(g, { width: 100, height: 100, iterations: 0, warm: { heat: 1, decaying: false } }, () => {});
    const start = startMessage(FakeWorker.last);
    expect(start.iterations).toBe(0); // idle: alive for a drag reheat
    expect(start.warm?.positions).toBeUndefined();
    expect(start.sharedPositions).toBeDefined();
    expect(Array.from(g.positions)).toEqual(Array.from(before)); // now the shared view, carrying the layout
    handle.stop();
    await handle.settled;
  });

  it("without a worker, continues on this thread from the current positions on the handed-over schedule", async () => {
    // (the node environment has no Worker: the synchronous fallback)
    const idle = laidOutPath();
    const before = idle.positions.slice();
    let frames = 0;
    await startWorkerLayout(idle, { width: 100, height: 100, iterations: 0, warm: { heat: 0.3, decaying: false } }, () => { frames++; }).settled;
    expect(idle.positions).toEqual(before); // no ticks left: untouched, and not re-seeded
    expect(frames).toBe(1);

    for (const [iterations, heat, decaying] of [[40, 0.5, true], [25, 1, false]] as const) {
      const g = laidOutPath();
      await startWorkerLayout(g, { width: 100, height: 100, iterations, warm: { heat, decaying } }, () => {}).settled;
      expect(g.positions).toEqual(warmReference(iterations, heat, decaying));
    }
  });

  it("a worker error mid-way continues the same warm schedule on this thread, not a fresh seeded layout", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("crossOriginIsolated", false);
    const g = laidOutPath();
    const handle = startWorkerLayout(g, { width: 100, height: 100, iterations: 30, warm: { heat: 0.6, decaying: true } }, () => {});
    FakeWorker.last?.onerror?.(new Event("error"));
    await handle.settled;
    expect(g.positions).toEqual(warmReference(30, 0.6, true));
  });
});
