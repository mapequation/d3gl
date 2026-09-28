/**
 * A GPU layout's lifetime is its device's (#311, spec §6.6, §15 Q3), at the transport: `moveDevice` stops
 * the GPU run while its device is alive — every texture, framebuffer, buffer and fence it made is deleted —
 * and continues the layout **warm** on the next device, or on the worker without one: from the last
 * harvested positions, with the ticks left of its budget and the heat it had reached. A settled layout
 * continues as an idle run — on the next device's GPU, or on the worker without one — so a drag still
 * reflows, and a drag in progress is replayed onto the new run. A lost context continues the same way on the worker. The teardown tolerates a destroyed luma device
 * (its context lives on, so it still frees) and a lost context (no GL call at all). The engine legs (the
 * pre-swap hook, each swap direction) are in `gpu-backend-integration.browser.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { WebGLDevice } from "@luma.gl/webgl";
import { makeTestDevice } from "./_device.js";
import { startGpuLayout, type GpuLayoutTransport } from "../gpu-transport.js";
import { observeGpuLayoutFrames } from "../gpu-stream.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { Cooling, DEFAULT_FORCE, DRAG_HEAT, RECOOL_TICKS, seedPositions } from "../../force.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import type { MainToWorker, StartMessage } from "../../worker-protocol.js";
import type { LeafStyle, LODView } from "../../lod-frame.js";

const W = 400;
const H = 300;

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Wait (in animation frames) until `done()` holds; fails the test after `frames` frames. */
async function until(done: () => boolean, what: string, frames = 600): Promise<void> {
  for (let i = 0; i < frames && !done(); i++) await nextFrame();
  expect(done(), `timed out waiting for ${what}`).toBe(true);
}

/** A seeded ring: a layout in progress for the GPU to continue. */
function seededRing(n: number): NetworkGraph {
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
  }
  const g = buildGraph({ nodeCount: n, source, target });
  seedPositions(g, W, H, { force: DEFAULT_FORCE });
  return g;
}

async function webglDevice(): Promise<WebGLDevice> {
  const device = await makeTestDevice();
  if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
  return device;
}

/**
 * Every texture, buffer and fence created on `gl` from now on that is still alive: the storage a run leaks if
 * it is not freed. Other contexts (a second device) are ignored. Framebuffers are counted through luma
 * instead ({@link framebuffersActive}): luma 9.3.3's `WEBGLFramebuffer.destroy()` never deletes the GL object
 * behind it (its `super.destroy()` sets `destroyed` before the check that guards `deleteFramebuffer`, still
 * so in 9.4.2), so every framebuffer d3gl destroys stays behind as an empty, storage-free GL name until its
 * context is collected — an upstream bug outside the layout's control.
 */
function liveGlObjects(gl: WebGL2RenderingContext): { live: Set<object> } {
  const live = new Set<object>();
  const P = WebGL2RenderingContext.prototype;
  const add = (ctx: WebGL2RenderingContext, obj: object | null): void => {
    if (ctx === gl && obj) live.add(obj);
  };
  const drop = (ctx: WebGL2RenderingContext, obj: object | null): void => {
    if (ctx === gl && obj) live.delete(obj);
  };
  const { createTexture, deleteTexture, createBuffer, deleteBuffer, fenceSync, deleteSync } = P;
  vi.spyOn(P, "createTexture").mockImplementation(function (this: WebGL2RenderingContext) {
    const t = createTexture.call(this);
    add(this, t);
    return t;
  });
  vi.spyOn(P, "deleteTexture").mockImplementation(function (this: WebGL2RenderingContext, t: WebGLTexture | null) {
    drop(this, t);
    deleteTexture.call(this, t);
  });
  vi.spyOn(P, "createBuffer").mockImplementation(function (this: WebGL2RenderingContext) {
    const b = createBuffer.call(this);
    add(this, b);
    return b;
  });
  vi.spyOn(P, "deleteBuffer").mockImplementation(function (this: WebGL2RenderingContext, b: WebGLBuffer | null) {
    drop(this, b);
    deleteBuffer.call(this, b);
  });
  vi.spyOn(P, "fenceSync").mockImplementation(function (this: WebGL2RenderingContext, condition: GLenum, flags: GLbitfield) {
    const f = fenceSync.call(this, condition, flags);
    add(this, f);
    return f;
  });
  vi.spyOn(P, "deleteSync").mockImplementation(function (this: WebGL2RenderingContext, f: WebGLSync | null) {
    drop(this, f);
    deleteSync.call(this, f);
  });
  return { live };
}

/** The luma framebuffers alive on `device` (luma's own resource count; see {@link liveGlObjects}). */
function framebuffersActive(device: WebGLDevice): number {
  return device.statsManager.getStats("GPU Resource Counts").get("Framebuffers Active").count;
}

/** The kinds of the GL objects in `live` (`WebGLTexture`, `WebGLBuffer`, `WebGLSync`). */
function leaked(live: Set<object>): string[] {
  return [...live].map((obj) => obj.constructor.name);
}

/** The layout-worker messages posted from now on, cloned at post time (as the worker receives them). */
function workerPosts(): MainToWorker[] {
  const posted: MainToWorker[] = [];
  const post = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message: MainToWorker) {
    posted.push(structuredClone(message));
    post.call(this, message);
  });
  return posted;
}

function startOf(posted: MainToWorker[]): StartMessage | undefined {
  const start = posted.find((m) => m.type === "start");
  return start?.type === "start" ? start : undefined;
}

/** The heat a `cool(budget)` schedule has after `ticks` ticks — what the GPU run had reached. */
function heatAfter(budget: number, ticks: number): number {
  const c = new Cooling();
  c.cool(budget);
  for (let t = 0; t < ticks; t++) c.next();
  return c.heat;
}

/** Follow the streamed GPU frames: the ticks of the last harvest, and how many frames ran. */
function followFrames(): { harvested: () => number; frames: () => number; stop: () => void } {
  let harvested = -1;
  let frames = 0;
  const stop = observeGpuLayoutFrames((s) => {
    frames++;
    if (s.harvested) harvested = s.harvestedTicks;
  });
  return { harvested: () => harvested, frames: () => frames, stop };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GPU layout swap policy at the transport (#311)", () => {
  it("moveDevice mid-run frees every GPU object on the live device, then continues warm on the worker", async () => {
    const device = await webglDevice();
    const gl = device.gl;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const objects = liveGlObjects(gl);
    const framebuffers = framebuffersActive(device);
    const posted = workerPosts();
    const follow = followFrames();
    const transports: GpuLayoutTransport[] = [];
    const g = seededRing(400);
    // A decaying schedule, so the heat carried over is a real number, not the cold start's held 1.
    const budget = 600;
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: budget, frameEvery: 5, warm: { heat: 1, decaying: true } },
      () => {}, undefined, (t) => transports.push(t));
    try {
      await until(() => follow.harvested() >= 10, "a few harvests");
      const ticks = follow.harvested();
      expect(ticks).toBeLessThan(budget);
      const atMove = g.positions.slice();
      expect(objects.live.size, "the run made no GPU objects to free").toBeGreaterThan(0);

      handle.moveDevice?.(Promise.resolve(null));
      // Freed synchronously, while the device and its context are still alive.
      expect(gl.isContextLost()).toBe(false);
      expect(leaked(objects.live), "GPU objects the stopped run left alive").toEqual([]);
      expect(framebuffersActive(device), "framebuffers the stopped run left alive").toBe(framebuffers);

      await until(() => startOf(posted) !== undefined, "the worker start");
      const start = startOf(posted);
      expect(start?.iterations, "the worker continues with the ticks left").toBe(budget - ticks);
      expect(start?.warm?.decaying).toBe(true);
      expect(start?.warm?.heat, "the heat the GPU run had reached").toBe(heatAfter(budget, ticks));
      expect(start?.warm?.positions, "from the last harvested positions").toEqual(atMove);
      expect(transports).toEqual(["gpu", "worker"]);
      expect(handle.transport).toBe("worker");
      const moved = warn.mock.calls.filter((c) => String(c[0]).includes("continues on the CPU worker after a render-backend swap"));
      expect(moved).toHaveLength(1);

      // The GPU loop has stopped; the worker run settles the handle.
      const gpuFrames = follow.frames();
      await handle.settled;
      expect(follow.frames()).toBe(gpuFrames);
      for (let i = 0; i < g.positions.length; i++) expect(Number.isFinite(g.positions[i] ?? Number.NaN)).toBe(true);
    } finally {
      follow.stop();
      handle.stop();
      device.destroy();
    }
  });

  it("a spatial LOD stream moved to the worker continues with the latest leaf style and view (#343, #433)", async () => {
    const device = await webglDevice();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const posted = workerPosts();
    const follow = followFrames();
    const g = seededRing(400);
    const style = (r: number): LeafStyle => ({ radii: new Float32Array(g.nodeCount).fill(r), weight: g.strength, links: true });
    const view = (k: number): LODView => ({ transform: { k, x: W / 2, y: H / 2 }, fitPad: 3, width: W, height: H, screenSized: true, fadeBand: 0 });
    let trees = 0;
    const handle = startGpuLayout(device, g, {
      width: W, height: H, iterations: 600, frameEvery: 5, warm: { heat: 1, decaying: true },
      lod: true, lodSource: "spatial", lodStyle: style(2), lodStyleVersion: 1, lodView: view(1),
    }, () => {}, (tree, streamed) => {
      if (tree) trees++;
      streamed?.release(); // nothing reads it here: hand the buffers straight back
    });
    try {
      await until(() => follow.harvested() >= 10 && trees > 2, "a few relayed spatial trees");
      handle.setLODStyle?.(style(4), 2);
      handle.setLODView?.(view(3));
      // The GPU run's LOD worker got both.
      expect(posted.filter((m) => m.type === "lod-style")).toHaveLength(1);
      expect(posted.filter((m) => m.type === "lod-view")).toHaveLength(1);

      handle.moveDevice?.(Promise.resolve(null));
      await until(() => startOf(posted) !== undefined, "the worker start");
      const start = startOf(posted);
      expect(start?.lodSource).toBe("spatial");
      expect(start?.lodStyleVersion, "the moved run aggregates the latest style").toBe(2);
      expect(start?.lodStyle?.radii[0]).toBe(4);
      expect(start?.lodView, "and cuts its rows at the latest view").toEqual(view(3));
      // Later changes reach the worker run.
      const before = posted.length;
      handle.setLODStyle?.(style(5), 3);
      handle.setLODView?.(view(5));
      const after = posted.slice(before).map((m) => m.type);
      expect(after).toEqual(["lod-style", "lod-view"]);
      await handle.settled;
    } finally {
      follow.stop();
      handle.stop();
      device.destroy();
    }
  });

  it("a settled layout continues as an idle worker, and a drag still reflows it", async () => {
    const device = await webglDevice();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = seededRing(200);
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 30 }, () => {});
    try {
      await handle.settled;
      const posted = workerPosts();
      handle.moveDevice?.(Promise.resolve(null));
      await until(() => startOf(posted) !== undefined, "the worker start");
      expect(startOf(posted)?.iterations, "idle: no ticks left").toBe(0);
      expect(startOf(posted)?.warm).toBeDefined();

      const before = g.positions.slice();
      const held = Float32Array.of((before[0] ?? 0) + 300, before[1] ?? 0);
      handle.pin(Uint32Array.of(0), held);
      expect(posted.some((m) => m.type === "pin"), "the drag reached the worker").toBe(true);
      const reflowed = (): boolean => {
        for (let i = 1; i < 200; i++) if (g.positions[i * 2] !== before[i * 2]) return true;
        return false;
      };
      await until(reflowed, "the rest of the layout to reflow around the held node");
      handle.unpin();
      expect(posted.some((m) => m.type === "unpin")).toBe(true);
    } finally {
      handle.stop();
      device.destroy();
    }
  });

  it("moveDevice to another WebGL device continues warm on the GPU there", async () => {
    const first = await webglDevice();
    const second = await webglDevice();
    const objects = liveGlObjects(first.gl);
    const framebuffers = framebuffersActive(first);
    const posted = workerPosts();
    const follow = followFrames();
    const transports: GpuLayoutTransport[] = [];
    const g = seededRing(400);
    const budget = 600;
    const finals: number[] = [];
    const unobserve = observeGpuLayoutFrames((s) => {
      if (s.harvested) finals.push(s.harvestedTicks);
    });
    // Counts ticks, so no convergence stop (#376) may cut the budget short: a model without repulsion has no
    // equilibrium spacing, so the stop never arms (as on the CPU); and a cold start, no multilevel seed (#353).
    const noStop = { multilevel: false, force: { ...DEFAULT_FORCE, repulsion: 0 } };
    const handle = startGpuLayout(first, g, { width: W, height: H, iterations: budget, frameEvery: 5, ...noStop }, () => {}, undefined,
      (t) => transports.push(t));
    try {
      await until(() => follow.harvested() >= 10, "a few harvests");
      const ticks = follow.harvested();
      handle.moveDevice?.(Promise.resolve(second));
      expect(leaked(objects.live), "GPU objects left alive on the first device").toEqual([]);
      expect(framebuffersActive(first), "framebuffers left alive on the first device").toBe(framebuffers);
      finals.length = 0;
      await handle.settled;
      expect(transports).toEqual(["gpu", "gpu"]);
      expect(handle.transport).toBe("gpu");
      expect(startOf(posted), "no worker started").toBeUndefined();
      // The run on the second device harvests its last copy at exactly the ticks that were left.
      expect(finals[finals.length - 1]).toBe(budget - ticks);
    } finally {
      unobserve();
      follow.stop();
      handle.stop();
      first.destroy();
      second.destroy();
    }
  });

  it("a settled layout moved to another WebGL device idles on the GPU there, and a drag still reflows it", async () => {
    const first = await webglDevice();
    const second = await webglDevice();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const transports: GpuLayoutTransport[] = [];
    const follow = followFrames();
    const g = seededRing(200);
    let repaints = 0;
    const handle = startGpuLayout(first, g, { width: W, height: H, iterations: 30 }, () => { repaints++; }, undefined,
      (t) => transports.push(t));
    try {
      await handle.settled;
      const posted = workerPosts();
      const settledAt = g.positions.slice();
      const repaintsAtMove = repaints;
      handle.moveDevice?.(Promise.resolve(second));
      await until(() => transports.length === 2, "the run on the second device");
      expect(transports).toEqual(["gpu", "gpu"]);
      expect(handle.transport).toBe("gpu");
      // Idle: no tick and no seed, so the layout stays exactly where it settled.
      const frames = follow.frames();
      for (let i = 0; i < 10; i++) await nextFrame();
      expect(follow.frames(), "an idle run streams no frame").toBe(frames);
      expect(repaints, "an idle run repainted the positions already on screen").toBe(repaintsAtMove);
      expect(Array.from(g.positions)).toEqual(Array.from(settledAt));

      handle.pin(Uint32Array.of(0), Float32Array.of((settledAt[0] ?? 0) + 300, settledAt[1] ?? 0));
      const reflowed = (): boolean => {
        for (let i = 1; i < 200; i++) if (g.positions[i * 2] !== settledAt[i * 2]) return true;
        return false;
      };
      await until(reflowed, "the rest of the layout to reflow around the held node");
      expect(follow.frames(), "the drag reflows on the GPU").toBeGreaterThan(frames);
      expect(startOf(posted), "no worker started").toBeUndefined();
      handle.unpin();
    } finally {
      follow.stop();
      handle.stop();
      first.destroy();
      second.destroy();
    }
  });

  it("a drag in progress is replayed onto the run the move starts", async () => {
    const device = await webglDevice();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const follow = followFrames();
    const g = seededRing(400);
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 600, frameEvery: 5 }, () => {});
    try {
      await until(() => follow.harvested() >= 5, "a harvest");
      const held = Float32Array.of(g.positions[6] ?? 0, g.positions[7] ?? 0);
      handle.pin(Uint32Array.of(3), held);
      const posted = workerPosts();
      handle.moveDevice?.(Promise.resolve(null));
      await until(() => posted.some((m) => m.type === "pin"), "the replayed pin");
      const start = posted.findIndex((m) => m.type === "start");
      const pin = posted.findIndex((m) => m.type === "pin");
      expect(start).toBeGreaterThanOrEqual(0);
      expect(pin).toBeGreaterThan(start);
      const replayed = posted[pin];
      expect(replayed?.type === "pin" ? Array.from(replayed.ids) : []).toEqual([3]);
      expect(startOf(posted)?.iterations, "the initial run goes on, the drag riding on it").toBeGreaterThan(0);
    } finally {
      follow.stop();
      handle.stop();
      device.destroy();
    }
  });

  it("a move mid re-cool resumes as a re-cool: a pin on the next device reheats at the drag heat at once", async () => {
    const first = await webglDevice();
    const second = await webglDevice();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let ticksDone = 0;
    let harvested = -1;
    const unobserve = observeGpuLayoutFrames((s) => {
      ticksDone = s.ticksDone;
      if (s.harvested) harvested = s.harvestedTicks;
    });
    const transports: GpuLayoutTransport[] = [];
    const g = seededRing(400);
    const handle = startGpuLayout(first, g, { width: W, height: H, iterations: 30, frameEvery: 2 }, () => {}, undefined,
      (t) => transports.push(t));
    try {
      await handle.settled;
      const held = Float32Array.of(g.positions[0] ?? 0, g.positions[1] ?? 0);
      handle.pin(Uint32Array.of(0), held);
      const grabbed = ticksDone;
      await until(() => harvested > grabbed, "a drag frame");
      handle.unpin();
      const released = ticksDone;
      await until(() => harvested > released, "a harvest in the re-cool");
      expect(harvested - released, "the re-cool ran out before the move").toBeLessThan(RECOOL_TICKS);

      handle.moveDevice?.(Promise.resolve(second));
      await until(() => transports.length === 2, "the run on the second device");
      const hold = vi.spyOn(GpuForceLayout.prototype, "hold");
      handle.pin(Uint32Array.of(0), held);
      // As in any re-cool: the pin turns the tail into a drag at once. An initial run would let it ride.
      expect(hold, "the pin did not reheat the resumed re-cool").toHaveBeenCalledWith(DRAG_HEAT);
      handle.unpin();
    } finally {
      unobserve();
      handle.stop();
      first.destroy();
      second.destroy();
    }
  });

  it("a move mid re-cool to the worker hands over the tail as a re-cool", async () => {
    const device = await webglDevice();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let ticksDone = 0;
    let harvested = -1;
    const unobserve = observeGpuLayoutFrames((s) => {
      ticksDone = s.ticksDone;
      if (s.harvested) harvested = s.harvestedTicks;
    });
    const g = seededRing(400);
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 30, frameEvery: 2 }, () => {});
    try {
      await handle.settled;
      handle.pin(Uint32Array.of(0), Float32Array.of(g.positions[0] ?? 0, g.positions[1] ?? 0));
      const grabbed = ticksDone;
      await until(() => harvested > grabbed, "a drag frame");
      handle.unpin();
      const released = ticksDone;
      await until(() => harvested > released, "a harvest in the re-cool");
      const posted = workerPosts();
      handle.moveDevice?.(Promise.resolve(null));
      await until(() => startOf(posted) !== undefined, "the worker start");
      const start = startOf(posted);
      expect(start?.iterations, "the ticks left of the re-cool").toBeGreaterThan(0);
      expect(start?.iterations).toBeLessThan(RECOOL_TICKS);
      expect(start?.warm).toEqual(expect.objectContaining({ decaying: true, recool: true }));
      expect(start?.warm?.heat).toBeLessThan(DRAG_HEAT);
    } finally {
      unobserve();
      handle.stop();
      device.destroy();
    }
  });

  it("a drag released while the move waits for its device gets its whole re-cool, not the idle run it was live for", async () => {
    const device = await webglDevice();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = seededRing(200);
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 30 }, () => {});
    try {
      await handle.settled;
      const posted = workerPosts();
      handle.pin(Uint32Array.of(0), Float32Array.of((g.positions[0] ?? 0) + 100, g.positions[1] ?? 0));
      let resolveNext: (device: null) => void = () => {};
      handle.moveDevice?.(new Promise<null>((resolve) => (resolveNext = resolve)));
      handle.unpin(); // an "auto" upgrade takes ~200 ms: the drag ends before the next device is there
      resolveNext(null);
      await until(() => startOf(posted) !== undefined, "the worker start");
      const start = startOf(posted);
      expect(start?.iterations, "the released drag's re-cool").toBe(RECOOL_TICKS);
      expect(start?.warm).toEqual(expect.objectContaining({ heat: DRAG_HEAT, decaying: true, recool: true }));
      expect(posted.some((m) => m.type === "pin"), "the released drag was replayed").toBe(false);
    } finally {
      handle.stop();
      device.destroy();
    }
  });

  it("a lost context mid-run continues warm on the worker, with no further GL call", async () => {
    const device = await webglDevice();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posted = workerPosts();
    const follow = followFrames();
    const transports: GpuLayoutTransport[] = [];
    const g = seededRing(400);
    const budget = 600;
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: budget, frameEvery: 5, warm: { heat: 1, decaying: true } },
      () => {}, undefined, (t) => transports.push(t));
    try {
      await until(() => follow.harvested() >= 10, "a few harvests");
      const ticks = follow.harvested();
      const atLoss = g.positions.slice();
      let glDeletes = 0;
      const P = WebGL2RenderingContext.prototype;
      for (const name of ["deleteTexture", "deleteFramebuffer", "deleteBuffer", "deleteSync", "deleteProgram"] as const) {
        vi.spyOn(P, name).mockImplementation(() => { glDeletes++; });
      }
      device.gl.getExtension("WEBGL_lose_context")?.loseContext();

      await until(() => startOf(posted) !== undefined, "the worker start");
      const start = startOf(posted);
      expect(start?.iterations).toBe(budget - ticks);
      expect(start?.warm?.heat).toBe(heatAfter(budget, ticks));
      expect(start?.warm?.positions).toEqual(atLoss);
      expect(transports).toEqual(["gpu", "worker"]);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("continues on the CPU worker: the WebGL context was lost"))).toHaveLength(1);
      await handle.settled;
      handle.stop();
      expect(glDeletes, "GL calls on the lost context").toBe(0);
    } finally {
      follow.stop();
      handle.stop();
    }
  });

  it("a failed fence wait on a context that is still alive frees the GPU run, then continues warm on the worker", async () => {
    const device = await webglDevice();
    const gl = device.gl;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const objects = liveGlObjects(gl);
    const framebuffers = framebuffersActive(device);
    const posted = workerPosts();
    const follow = followFrames();
    const g = seededRing(400);
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 600, frameEvery: 5 }, () => {});
    try {
      await until(() => follow.harvested() >= 5, "a few harvests");
      // WAIT_FAILED without a loss (an invalid sync): the stream stops as for a lost context, but GL still works.
      vi.spyOn(WebGL2RenderingContext.prototype, "clientWaitSync").mockImplementation(function (this: WebGL2RenderingContext) {
        return this.WAIT_FAILED;
      });
      await until(() => startOf(posted) !== undefined, "the worker start");
      expect(gl.isContextLost()).toBe(false);
      expect(leaked(objects.live), "GPU objects the stopped run left alive on a live context").toEqual([]);
      expect(framebuffersActive(device), "framebuffers the stopped run left alive").toBe(framebuffers);
      expect(startOf(posted)?.iterations).toBeGreaterThan(0);
      await handle.settled;
    } finally {
      follow.stop();
      handle.stop();
      device.destroy();
    }
  });
});

describe("GPU layout teardown tolerates a gone device (#311)", () => {
  it("stop() after the luma device was destroyed does not throw and still frees (the context lives on)", async () => {
    const device = await webglDevice();
    const objects = liveGlObjects(device.gl);
    const framebuffers = framebuffersActive(device);
    const follow = followFrames();
    const handle = startGpuLayout(device, seededRing(300), { width: W, height: H, iterations: 100_000 }, () => {});
    try {
      await until(() => follow.frames() >= 3, "a few frames");
      device.destroy(); // detaches the device from its context; the context itself stays alive
      expect(() => handle.stop()).not.toThrow();
      expect(leaked(objects.live)).toEqual([]);
      expect(framebuffersActive(device)).toBe(framebuffers);
      await handle.settled;
    } finally {
      follow.stop();
    }
  });

  it("stop() on a lost context — before its event arrives — makes no GL call", async () => {
    const device = await webglDevice();
    const follow = followFrames();
    const handle = startGpuLayout(device, seededRing(300), { width: W, height: H, iterations: 100_000 }, () => {});
    try {
      await until(() => follow.frames() >= 3, "a few frames");
      device.gl.getExtension("WEBGL_lose_context")?.loseContext();
      let glDeletes = 0;
      const P = WebGL2RenderingContext.prototype;
      for (const name of ["deleteTexture", "deleteFramebuffer", "deleteBuffer", "deleteSync", "deleteProgram", "deleteVertexArray"] as const) {
        vi.spyOn(P, name).mockImplementation(() => { glDeletes++; });
      }
      expect(() => handle.stop()).not.toThrow();
      expect(glDeletes).toBe(0);
      await handle.settled;
    } finally {
      follow.stop();
      device.destroy();
    }
  });
});
