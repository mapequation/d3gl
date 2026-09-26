import { describe, it, expect, vi, afterEach } from "vitest";
import { startGpuLayout, type GpuLayoutOptions } from "../gpu-transport.js";
import * as workerMod from "../../worker-transport.js";
import type { WorkerLayoutHandle } from "../../worker-transport.js";
import { buildGraph } from "../../graph.js";

/** A stand-in worker handle whose `shared` the test flips, to check the GPU handle reads it live. */
function fakeWorkerHandle(state: { shared: boolean }): WorkerLayoutHandle {
  return {
    get shared() { return state.shared; },
    settled: Promise.resolve(),
    stop() {},
    pin() {},
    unpin() {},
  };
}

/** Every option a flat worker layout takes — the fallback must hand all of them over (#312). */
const ALL_OPTIONS: GpuLayoutOptions = {
  width: 120,
  height: 80,
  iterations: 12,
  force: { repulsion: 2 },
  multilevel: false,
  lod: true,
  coarsen: { minNodes: 4, maxLevels: 3 },
  frameEvery: 2,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startGpuLayout fallback", () => {
  it("falls back to the worker backend when the GPU device is unavailable", () => {
    const spy = vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle({ shared: false }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const h = startGpuLayout(null, g, { width: 100, height: 100, iterations: 10 }, () => {});
    expect(spy).toHaveBeenCalledOnce();
    expect(typeof h.stop).toBe("function");
  });

  it("hands the worker every layout option and the LOD-tree callback (#312)", () => {
    const spy = vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle({ shared: false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const onFrame = (): void => {};
    const onLODTree = (): void => {};
    const onTransport = vi.fn();
    const h = startGpuLayout(null, g, ALL_OPTIONS, onFrame, onLODTree, onTransport);
    expect(spy).toHaveBeenCalledWith(g, expect.objectContaining(ALL_OPTIONS), onFrame, onLODTree);
    // The engine learns the resolved transport before the worker can post a frame.
    expect(onTransport).toHaveBeenCalledWith("worker");
    expect(onTransport.mock.invocationCallOrder[0]).toBeLessThan(spy.mock.invocationCallOrder[0] ?? 0);
    expect(h.transport).toBe("worker");
    // One warning, naming the reason.
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/fell back to the CPU worker: no WebGL device/);
  });

  it("resolves a device promise: pending first, then the worker with every option, reporting it live (#297)", async () => {
    const inner = { shared: false };
    const spy = vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle(inner));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const onTransport = vi.fn();
    const onLODTree = (): void => {};
    const h = startGpuLayout(Promise.resolve(null), g, ALL_OPTIONS, () => {}, onLODTree, onTransport);
    expect(h.transport).toBe("pending");
    expect(onTransport).not.toHaveBeenCalled();
    await h.settled;
    expect(onTransport).toHaveBeenCalledWith("worker");
    expect(spy).toHaveBeenCalledWith(g, expect.objectContaining(ALL_OPTIONS), expect.any(Function), onLODTree);
    expect(h.transport).toBe("worker");
    // `shared` is read from the live worker handle, not copied once.
    expect(h.shared).toBe(false);
    inner.shared = true;
    expect(h.shared).toBe(true);
    inner.shared = false;
    expect(h.shared).toBe(false);
  });

  it("falls back with every option when the device promise rejects", async () => {
    const spy = vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle({ shared: false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const onTransport = vi.fn();
    const onLODTree = (): void => {};
    const h = startGpuLayout(Promise.reject(new Error("lost")), g, ALL_OPTIONS, () => {}, onLODTree, onTransport);
    await h.settled;
    expect(spy).toHaveBeenCalledWith(g, expect.objectContaining(ALL_OPTIONS), expect.any(Function), onLODTree);
    expect(onTransport).toHaveBeenCalledWith("worker");
    expect(h.transport).toBe("worker");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/device promise rejected/);
  });

  it("falls back without a warning when the caller expects it (backend:'auto', #375), keeping every option", async () => {
    const spy = vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle({ shared: false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const onTransport = vi.fn();
    const onLODTree = (): void => {};
    const quiet: GpuLayoutOptions = { ...ALL_OPTIONS, warnUnsupported: false };
    // Unsupported, synchronously and through a device promise: the worker runs, silently.
    const sync = startGpuLayout(null, g, quiet, () => {}, onLODTree, onTransport);
    const async = startGpuLayout(Promise.resolve(null), g, quiet, () => {}, onLODTree, onTransport);
    await async.settled;
    expect(sync.transport).toBe("worker");
    expect(async.transport).toBe("worker");
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) expect(call[1]).toEqual(expect.objectContaining(ALL_OPTIONS));
    expect(onTransport).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("still warns, with the error, when a quiet GPU layout fails rather than being unsupported", async () => {
    vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle({ shared: false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const cause = new Error("lost");
    const h = startGpuLayout(Promise.reject(cause), g, { ...ALL_OPTIONS, warnUnsupported: false }, () => {});
    await h.settled;
    expect(h.transport).toBe("worker");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/device promise rejected/);
    expect(warn.mock.calls[0]?.[1]).toBe(cause);
  });

  // A failure is told apart from an unsupported device by where it came from, not by the error value: a
  // promise rejected with nothing, or a start that throws `undefined`, is still a failure and still warns.
  it("still warns when a quiet GPU layout's device promise rejects with no error value", async () => {
    vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle({ shared: false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const h = startGpuLayout(Promise.reject(), g, { ...ALL_OPTIONS, warnUnsupported: false }, () => {});
    await h.settled;
    expect(h.transport).toBe("worker");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/device promise rejected/);
  });

  it("still warns when a quiet GPU layout throws `undefined` while starting", async () => {
    // The start throws once (a stand-in for a driver fault with no error object); the fallback's own start
    // then succeeds.
    vi.spyOn(workerMod, "startWorkerLayout")
      .mockImplementationOnce(() => { throw undefined; })
      .mockReturnValue(fakeWorkerHandle({ shared: false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const h = startGpuLayout(Promise.resolve(null), g, { ...ALL_OPTIONS, warnUnsupported: false }, () => {});
    await h.settled;
    expect(h.transport).toBe("worker");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/failed to start/);
  });

  it("starts nothing when stopped before the device resolves", async () => {
    const spy = vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle({ shared: false }));
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const onTransport = vi.fn();
    let resolveDevice: (d: null) => void = () => {};
    const device = new Promise<null>((r) => { resolveDevice = r; });
    const h = startGpuLayout(device, g, ALL_OPTIONS, () => {}, undefined, onTransport);
    h.stop();
    await h.settled;
    resolveDevice(null);
    await device;
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    expect(onTransport).not.toHaveBeenCalled();
  });
});

describe("startGpuLayout zero-node guard", () => {
  it("returns a valid handle and does not throw for a 0-node graph", () => {
    // With no device the null path falls back to the (mocked) worker; the guard itself protects the GPU
    // path from a zero-height texture.
    vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle({ shared: false }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph({ nodeCount: 0, source: [], target: [] });
    let handle: WorkerLayoutHandle | undefined;
    expect(() => {
      handle = startGpuLayout(null, g, { width: 100, height: 100, iterations: 10 }, () => {});
    }).not.toThrow();
    expect(handle).toBeDefined();
    expect(typeof handle?.stop).toBe("function");
  });

  it("settles a 0-node graph without waiting for the device", async () => {
    const spy = vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue(fakeWorkerHandle({ shared: false }));
    const g = buildGraph({ nodeCount: 0, source: [], target: [] });
    let frames = 0;
    const handle = startGpuLayout(new Promise<null>(() => {}), g, { width: 100, height: 100, iterations: 10 }, () => { frames++; });
    await handle.settled;
    expect(frames).toBe(1); // nothing to lay out: one paint
    expect(spy).not.toHaveBeenCalled();
  });
});
