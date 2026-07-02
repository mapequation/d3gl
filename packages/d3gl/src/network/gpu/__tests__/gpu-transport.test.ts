import { describe, it, expect, vi } from "vitest";
import { startGpuLayout } from "../gpu-transport.js";
import * as workerMod from "../../worker-transport.js";
import { buildGraph } from "../../graph.js";

describe("startGpuLayout fallback", () => {
  it("falls back to the worker backend when the GPU device is unavailable", () => {
    const spy = vi.spyOn(workerMod, "startWorkerLayout").mockReturnValue({ shared: false, settled: Promise.resolve(), stop() {}, pin() {}, unpin() {} });
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const h = startGpuLayout(null, g, { width: 100, height: 100, iterations: 10 }, () => {});
    expect(spy).toHaveBeenCalledOnce();
    expect(typeof h.stop).toBe("function");
    spy.mockRestore();
  });
});
