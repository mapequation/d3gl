/**
 * The GPU layouts' startup (#385): one pipeline for the flat layout and the nested one.
 *
 * - **The programs a run builds are known before it builds them**: `GpuForceLayout.programs` (its stop latch and
 *   its multilevel seed's passes included) and `GpuNestedLayout.programs` (its collision grid, whose search
 *   compiles the plan's cell refinement in, and its composition, compiled for the tree's depth), plus the probe's
 *   and the readback's, list exactly the programs the solver, the stream and the probe then link — as luma
 *   assembles them. The springs' variant comes from the degrees the graph holds, not from a pass over its edges.
 * - **They compile in parallel, and nothing waits on a link**: with `KHR_parallel_shader_compile` (faked here:
 *   the headless shell's SwiftShader has none, and completion is delayed a few polls), a run issues every program
 *   at once, reports `"gpu"`, and builds nothing until every link reported completion; no link status is read
 *   before that, a frame's poll asks at most one completion query per program, and the poll frames create no GL
 *   object. A second layout on the same device compiles and links nothing (luma's cache). A stop, a render-backend
 *   swap or a lost context during the compile abandons it cleanly; a failed link falls back to the worker with one
 *   warning; a device whose float-blend probe already failed falls back at once, compiling nothing.
 * - **Nothing the caller does during the compile is lost, and nothing is said too early**: a drag's pin reaches
 *   the stream (or the fallback worker) once it exists; a coarsening worker that could not start is reported
 *   only if the run goes ahead on the GPU.
 * - **The LOD worker coarsens during the compile** and its tree reaches the engine only once the stream exists,
 *   after the transport was reported.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { Device, Shader } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import { makeTestDevice } from "./_device.js";
import { startGpuLayout } from "../gpu-transport.js";
import { startGpuNestedLayout } from "../gpu-nested-transport.js";
import { GpuForceLayout, type GpuForceLayoutOptions } from "../gpu-force-layout.js";
import { GpuNestedLayout, nestedLayoutPlan, type GpuNestedLayoutOptions } from "../gpu-nested-layout.js";
import { nestedSolverTopology } from "../nested-topology.js";
import { AsyncPositionReadback } from "../async-readback.js";
import { blendProbeProgram, gpuCaps } from "../device-probe.js";
import { assembleProgram, programBuilt, uniquePrograms, type LayoutProgram } from "../programs.js";
import { SPRING_CHUNK } from "../hub-chunks.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import { DEFAULT_FORCE, seedPositions, type LayoutGraph } from "../../force.js";
import type { LODTree } from "../../lod.js";
import type { WorkerLayoutHandle } from "../../worker-transport.js";
import type { NestedLayoutTopology } from "../../nested-layout.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";
import { threeLevel, topo } from "../../__tests__/nested-fixtures.js";
import { fakeParallelCompile, hideParallelCompile } from "./_parallel-compile.js";

const W = 400;
const H = 300;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** `n` nodes in clusters of 20 with a few links between them: coarsens into a multilevel seed. */
function clustered(n: number, seed = 7): NetworkGraph {
  const rng = prng(seed);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 1; i < n; i++) {
    const base = i - (i % 20);
    source.push(i);
    target.push(i % 20 === 0 ? Math.floor(rng() * i) : base + Math.floor(rng() * (i - base)));
  }
  return buildGraph({ nodeCount: n, source, target });
}

function key(p: LayoutProgram): string {
  return `${p.vs}\u0000${p.fs}`;
}

/** The assembled programs `run` builds on `device`, read from luma's pipeline creations (a fresh device: no cache hits). */
function builtPrograms(device: Device, run: () => void): Set<string> {
  const spy = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
  try {
    run();
    const keys = new Set<string>();
    for (const [props] of spy.mock.calls) {
      const vs: Shader | null | undefined = props.vs;
      const fs: Shader | null | undefined = props.fs;
      keys.add(key({ vs: vs?.source ?? "", fs: fs?.source ?? "" }));
    }
    return keys;
  } finally {
    spy.mockRestore();
  }
}

function assembledKeys(device: Device, programs: readonly LayoutProgram[]): Set<string> {
  return new Set(uniquePrograms(programs).map((p) => key(assembleProgram(device, p))));
}

/** A star of `leaves` leaves on node 0 (a hub row when `leaves` > SPRING_CHUNK) among 400 nodes. */
function star(leaves: number, weighted = false): NetworkGraph & LayoutGraph {
  const source = Array.from({ length: leaves }, () => 0);
  const target = Array.from({ length: leaves }, (_, i) => i + 1);
  const g = buildGraph({ nodeCount: 400, source, target });
  return weighted ? { ...g, springWeight: new Float32Array(source.length).fill(0.5) } : g;
}

/** A graph over the tree's leaves (leaf ids are node ids), with a ring of edges. */
function graphOver(tree: NestedLayoutTopology): NetworkGraph {
  const n = tree.leafCount;
  return buildGraph({ nodeCount: n, source: Array.from({ length: n }, (_, i) => i), target: Array.from({ length: n }, (_, i) => (i + 1) % n) });
}

/** One module of `leaves` leaves whose leaf 0 links to every other (a hub row when `leaves` > SPRING_CHUNK + 1), beside a second module. */
function moduleStar(leaves: number): NestedLayoutTopology {
  const records: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  for (let id = 0; id < leaves + 20; id++) records.push({ id, path: id < leaves ? [1, id + 1] : [2, id - leaves + 1] });
  for (let j = 1; j < leaves; j++) {
    source.push(0);
    target.push(j);
  }
  return topo(buildModuleLODTree(leaves + 20, records, { source, target, weight: source.map(() => 1) }, []));
}

/** The programs of a whole GPU nested run on `device`, as its transport lists them (the solve's are packed). */
function nestedRunPrograms(device: Device, tree: NestedLayoutTopology, iterations: number): LayoutProgram[] {
  const plan = nestedLayoutPlan(nestedSolverTopology(tree, { iterations }));
  return [blendProbeProgram(), ...GpuNestedLayout.programs(plan), ...AsyncPositionReadback.programs(device, true)];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GPU layout programs, listed before they are built (#385)", () => {
  const cases: { name: string; graph: () => NetworkGraph & LayoutGraph; options: GpuForceLayoutOptions }[] = [
    { name: "flat, exact loop", graph: () => clustered(600), options: {} },
    { name: "flat, exact loop, multilevel", graph: () => clustered(600), options: { multilevel: true } },
    { name: "flat, tiles, multilevel", graph: () => clustered(5000), options: { multilevel: true } },
    { name: "weighted springs with a hub row", graph: () => star(SPRING_CHUNK + 20, true), options: {} },
    { name: "weighted springs with a hub row, multilevel", graph: () => star(SPRING_CHUNK + 20, true), options: { multilevel: true } },
    {
      name: "many segments, both paths",
      graph: () => buildGraph({ nodeCount: 3040, source: [0, 40], target: [1, 41] }),
      options: { segments: [{ start: 0, count: 40 }, { start: 40, count: 3000 }], exactMax: 32 },
    },
  ];

  for (const c of cases) {
    it(`GpuForceLayout.programs lists exactly what the solver links, as luma assembles it: ${c.name}`, async () => {
      const device = await makeTestDevice();
      const g = c.graph();
      seedPositions(g, W, H, { force: DEFAULT_FORCE });
      const made: GpuForceLayout[] = [];
      const built = builtPrograms(device, () => {
        made.push(new GpuForceLayout(device, g, DEFAULT_FORCE, c.options));
      });
      const listed = GpuForceLayout.programs(g, c.options);
      expect([...built].sort()).toEqual([...assembledKeys(device, listed)].sort());
      for (const p of listed) expect(programBuilt(device, p)).toBe(true);
      for (const layout of made) layout.destroy();
      device.destroy();
    });
  }

  it("the springs' variant comes from the degrees the graph holds, not from a pass over its edges", () => {
    for (const leaves of [SPRING_CHUNK - 20, SPRING_CHUNK + 20]) {
      const g = star(leaves);
      // Its edges emptied: a list built from the edges would lose the hub row; one read from the degrees keeps it.
      const edgeless = { ...g, source: new Uint32Array(0), target: new Uint32Array(0), edgeCount: 0 };
      expect(GpuForceLayout.programs(edgeless).map(key)).toEqual(GpuForceLayout.programs(g).map(key));
    }
    expect(GpuForceLayout.programs(star(SPRING_CHUNK + 20)).length).toBe(GpuForceLayout.programs(star(SPRING_CHUNK - 20)).length + 1);
  });

  it("the run's list (probe, solver, readback) is every program a GPU run builds", async () => {
    // Without KHR_parallel_shader_compile (hidden where a GPU has it) the run builds at once, inside this call.
    hideParallelCompile();
    const device = await makeTestDevice();
    const g = clustered(600);
    const handles: WorkerLayoutHandle[] = [];
    const built = builtPrograms(device, () => {
      handles.push(startGpuLayout(device, g, { width: W, height: H, iterations: 5 }, () => {}));
    });
    // Seeded: the solver is multilevel (the browser runs a real coarsening worker).
    const listed = [blendProbeProgram(), ...GpuForceLayout.programs(g, { multilevel: true }), ...AsyncPositionReadback.programs(device, false)];
    expect([...built].sort()).toEqual([...assembledKeys(device, listed)].sort());
    for (const h of handles) {
      await h.settled;
      h.stop();
    }
    device.destroy();
  });
});

describe("GPU nested layout programs, listed before they are built (#385)", () => {
  const cases: { name: string; tree: () => NestedLayoutTopology; options: GpuNestedLayoutOptions }[] = [
    { name: "three levels: tiles, the exact loop, links", tree: () => topo(threeLevel(6, 8, 40)), options: {} },
    { name: "three levels, with the collision grid's statistics passes", tree: () => topo(threeLevel(4, 4, 12)), options: { collisionStats: true } },
    { name: "a module whose leaf is a hub row", tree: () => moduleStar(SPRING_CHUNK + 20), options: {} },
    { name: "a module just below a hub row", tree: () => moduleStar(SPRING_CHUNK - 20), options: {} },
  ];

  for (const c of cases) {
    it(`GpuNestedLayout.programs lists exactly what the layout links, as luma assembles it: ${c.name}`, async () => {
      const device = await makeTestDevice();
      const plan = nestedLayoutPlan(nestedSolverTopology(c.tree(), { iterations: 20 }));
      const made: GpuNestedLayout[] = [];
      const built = builtPrograms(device, () => {
        made.push(new GpuNestedLayout(device, plan, c.options));
      });
      const listed = GpuNestedLayout.programs(plan, c.options);
      expect([...built].sort()).toEqual([...assembledKeys(device, listed)].sort());
      for (const p of listed) expect(programBuilt(device, p)).toBe(true);
      for (const layout of made) layout.destroy();
      device.destroy();
    });
  }

  it("a hub row compiles the springs' chunk pass: one program more", () => {
    const programs = (leaves: number): LayoutProgram[] => GpuNestedLayout.programs(nestedLayoutPlan(nestedSolverTopology(moduleStar(leaves), { iterations: 20 })));
    expect(programs(SPRING_CHUNK + 20).length).toBe(programs(SPRING_CHUNK - 20).length + 1);
  });

  it("the nested run's list (probe, layout, readback) is every program a GPU nested run builds", async () => {
    hideParallelCompile();
    const device = await makeTestDevice();
    const tree = topo(threeLevel(4, 4, 12));
    const pipelines = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
    const handle = startGpuNestedLayout(device, graphOver(tree), tree, { iterations: 20 }, () => {});
    await handle.settled; // the prep runs in a worker, so the build is a later task
    const built = new Set<string>();
    for (const [props] of pipelines.mock.calls) built.add(key({ vs: props.vs?.source ?? "", fs: props.fs?.source ?? "" }));
    pipelines.mockRestore();
    expect(handle.transport).toBe("gpu");
    expect([...built].sort()).toEqual([...assembledKeys(device, nestedRunPrograms(device, tree, 20))].sort());
    handle.stop();
    device.destroy();
  });
});

describe("GPU layout programs compile in parallel, before the solver (#385)", () => {
  it("issues every program at once, reports gpu, reads no link before completion, and builds once all linked", async () => {
    const fake = fakeParallelCompile(4);
    const device = await makeTestDevice();
    const proto = WebGL2RenderingContext.prototype;
    const programs = vi.spyOn(proto, "createProgram");
    const links = vi.spyOn(proto, "linkProgram");
    const deletes = vi.spyOn(proto, "deleteProgram");
    const pipelines = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
    const created = [
      vi.spyOn(proto, "createShader"),
      vi.spyOn(proto, "createTexture"),
      vi.spyOn(proto, "createFramebuffer"),
      vi.spyOn(proto, "createBuffer"),
      programs,
    ];
    const creations = (): number[] => created.map((spy) => spy.mock.calls.length);
    const g = clustered(600);
    const transports: string[] = [];
    let frames = 0;
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 20 }, () => { frames++; }, undefined, (t) => transports.push(t));
    try {
      const expected = uniquePrograms([blendProbeProgram(), ...GpuForceLayout.programs(g, { multilevel: true }), ...AsyncPositionReadback.programs(device, false)]).length;
      // All issued inside the call, none built, the transport resolved.
      expect(programs).toHaveBeenCalledTimes(expected);
      expect(links).toHaveBeenCalledTimes(expected);
      expect(pipelines).toHaveBeenCalledTimes(0);
      expect(transports).toEqual(["gpu"]);
      expect(handle.transport).toBe("gpu");
      const warmed = programs.mock.results.map((r) => r.value);
      // The poll frames, until the frame that builds: each asks at most one completion query per program, and
      // none creates a GL object (the compile's objects were all made inside the call).
      expect(fake.queries).toBe(0);
      const issued = creations();
      let pollFrames = 0;
      for (let i = 0; i < 2000 && pipelines.mock.calls.length === 0; i++) {
        const asked = fake.queries;
        await nextFrame();
        expect(fake.queries - asked).toBeLessThanOrEqual(expected);
        if (pipelines.mock.calls.length > 0) break;
        pollFrames++;
        expect(creations()).toEqual(issued);
      }
      expect(pollFrames, "the build came before the fake reported every link complete").toBeGreaterThanOrEqual(3);
      await handle.settled;
      expect(fake.blocking, "a link status was read before its link completed").toBe(0);
      expect(pipelines.mock.calls.length).toBeGreaterThan(0);
      // Every warmed program was freed once linked; the transport was reported once.
      for (const p of warmed) expect(deletes.mock.calls.some(([d]) => d === p)).toBe(true);
      expect(transports).toEqual(["gpu"]);
      expect(frames).toBeGreaterThan(0);
      for (let i = 0; i < g.nodeCount * 2; i++) expect(Number.isFinite(g.positions[i] ?? Number.NaN)).toBe(true);
    } finally {
      handle.stop();
      fake.restore();
    }

    // A second layout on the same device: every program is in luma's cache, so nothing is compiled or linked,
    // and the run is built inside the call.
    const fake2 = fakeParallelCompile(4);
    links.mockClear();
    const shaders = vi.spyOn(proto, "createShader");
    shaders.mockClear();
    const again = startGpuLayout(device, clustered(600, 11), { width: W, height: H, iterations: 5 }, () => {});
    try {
      expect(links).toHaveBeenCalledTimes(0);
      expect(shaders).toHaveBeenCalledTimes(0);
      expect(fake2.queries).toBe(0);
      await again.settled;
      expect(links).toHaveBeenCalledTimes(0);
    } finally {
      again.stop();
      fake2.restore();
      device.destroy();
    }
  });

  it("a stop during the compile frees every program and builds nothing", async () => {
    const fake = fakeParallelCompile(1_000_000);
    const device = await makeTestDevice();
    const proto = WebGL2RenderingContext.prototype;
    const programs = vi.spyOn(proto, "createProgram");
    const deletes = vi.spyOn(proto, "deleteProgram");
    const pipelines = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    try {
      const handle = startGpuLayout(device, clustered(600), { width: W, height: H, iterations: 20 }, () => {});
      await nextFrame();
      handle.stop();
      await handle.settled;
      const warmed = programs.mock.results.map((r) => r.value);
      expect(warmed.length).toBeGreaterThan(0);
      for (const p of warmed) expect(deletes.mock.calls.some(([d]) => d === p)).toBe(true);
      expect(terminate).toHaveBeenCalled(); // the coarsening worker
      await nextFrame();
      await nextFrame();
      expect(pipelines).toHaveBeenCalledTimes(0);
    } finally {
      fake.restore();
      device.destroy();
    }
  });

  it("a program that fails to link falls back to the worker with one warning", async () => {
    const fake = fakeParallelCompile(2, true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const device = await makeTestDevice();
    const transports: string[] = [];
    const handle = startGpuLayout(device, clustered(300), { width: W, height: H, iterations: 10 }, () => {}, undefined, (t) => transports.push(t));
    try {
      await handle.settled;
      expect(transports).toEqual(["gpu", "worker"]);
      expect(handle.transport).toBe("worker");
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/fell back to the CPU worker: a GPU layout program failed to link/);
    } finally {
      handle.stop();
      fake.restore();
      device.destroy();
    }
  });
});

describe("GPU layout startup: what the device already told us, and what the caller does meanwhile (#385)", () => {
  /** Count the workers started (the real ones: the run's coarsening worker and the fallback's layout worker). */
  function countWorkers(): { count: number } {
    const counter = { count: 0 };
    const Real = Worker;
    vi.stubGlobal(
      "Worker",
      class extends Real {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          counter.count++;
        }
      },
    );
    return counter;
  }

  it("a device whose float-blend probe already failed falls back at once: nothing compiled, no coarsening worker, one report", async () => {
    const device = await makeTestDevice();
    // The probe cannot build its target once, and the device keeps that verdict (device-probe caches it).
    const fbo = vi.spyOn(device, "createFramebuffer").mockImplementation(() => {
      throw new Error("framebuffer incomplete");
    });
    expect(gpuCaps(device)?.blendProbe).toBe("error");
    fbo.mockRestore();
    const fake = fakeParallelCompile(4);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const programs = vi.spyOn(WebGL2RenderingContext.prototype, "createProgram");
    const workers = countWorkers();
    const transports: string[] = [];
    const handle = startGpuLayout(device, clustered(600), { width: W, height: H, iterations: 10 }, () => {}, undefined, (t) => transports.push(t));
    try {
      expect(transports).toEqual(["worker"]);
      expect(programs).toHaveBeenCalledTimes(0);
      expect(workers.count).toBe(1); // the fallback's; no coarsening worker was started for a GPU run
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/fell back to the CPU worker: the functional float-blend probe could not run/);
      await handle.settled;
      expect(transports).toEqual(["worker"]);
    } finally {
      handle.stop();
      fake.restore();
      vi.unstubAllGlobals();
      device.destroy();
    }
  });

  it("a drag's pin during the compile reaches the stream once it exists; a pin released meanwhile reaches nothing", async () => {
    const fake = fakeParallelCompile(4);
    const device = await makeTestDevice();
    const setPinned = vi.spyOn(GpuForceLayout.prototype, "setPinned");
    const g = clustered(600);
    const handle = startGpuLayout(device, g, { width: W, height: H, iterations: 20 }, () => {});
    try {
      // No stream yet: the programs compile. The node is held where the drag put it once the stream runs.
      handle.pin(Uint32Array.of(3), new Float32Array([9, 9]));
      handle.pin(Uint32Array.of(5), new Float32Array([1234, -567]));
      await handle.settled;
      expect([g.positions[10], g.positions[11]]).toEqual([1234, -567]);
      expect(setPinned.mock.calls.some(([ids]) => ids?.[0] === 3)).toBe(false); // the latest pin only
    } finally {
      handle.stop();
      device.destroy();
    }

    // A fresh device, so this run compiles too (the first device has every program linked).
    setPinned.mockClear();
    const fresh = await makeTestDevice();
    const released = startGpuLayout(fresh, clustered(600, 9), { width: W, height: H, iterations: 10 }, () => {});
    try {
      released.pin(Uint32Array.of(5), new Float32Array([1234, -567]));
      released.unpin();
      await released.settled;
      expect(setPinned.mock.calls.some(([ids]) => ids !== null)).toBe(false);
    } finally {
      released.stop();
      fake.restore();
      fresh.destroy();
    }
  });

  it("a drag's pin during the compile reaches the fallback worker when a link fails", async () => {
    const fake = fakeParallelCompile(2, true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const device = await makeTestDevice();
    const posts: string[] = [];
    const origPost = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message: unknown, options?: StructuredSerializeOptions) {
      if (typeof message === "object" && message !== null && "type" in message && typeof message.type === "string") posts.push(message.type);
      origPost.call(this, message, options);
    });
    const handle = startGpuLayout(device, clustered(300), { width: W, height: H, iterations: 10 }, () => {});
    try {
      handle.pin(Uint32Array.of(5), new Float32Array([1234, -567]));
      for (let i = 0; i < 200 && handle.transport !== "worker"; i++) await nextFrame();
      expect(handle.transport).toBe("worker");
      expect(posts).toContain("pin");
    } finally {
      handle.stop();
      fake.restore();
      device.destroy();
    }
  });

  it("a coarsening worker that cannot start is reported once the run goes ahead on the GPU, and never if it falls back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const device = await makeTestDevice();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new DOMException("blocked by the page's policy", "SecurityError");
        }
      },
    );
    const coarsening = (): string[] => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("could start to coarsen"));
    const fake = fakeParallelCompile(4);
    const ahead = startGpuLayout(device, clustered(600), { width: W, height: H, iterations: 10 }, () => {});
    try {
      expect(coarsening()).toEqual([]); // compiling: the run may still fall back
      await ahead.settled;
      expect(ahead.transport).toBe("gpu");
      expect(coarsening()).toHaveLength(1);
    } finally {
      ahead.stop();
      fake.restore();
      device.destroy();
    }

    // A fresh device, so this run compiles too (and its links fail).
    warn.mockClear();
    const failing = fakeParallelCompile(2, true);
    const fresh = await makeTestDevice();
    const back = startGpuLayout(fresh, clustered(300, 3), { width: W, height: H, iterations: 10 }, () => {});
    try {
      await back.settled;
      expect(back.transport).toBe("worker");
      expect(coarsening()).toEqual([]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("a GPU layout program failed to link"))).toBe(true);
    } finally {
      back.stop();
      failing.restore();
      vi.unstubAllGlobals();
      fresh.destroy();
    }
  });
});

describe("GPU layout LOD relay while the programs compile (#385)", () => {
  it("coarsens during the compile, and hands the tree over only once the stream exists, after the transport", async () => {
    // The compile completes only once the worker has answered with the tree's topology (released below).
    const fake = fakeParallelCompile(Number.POSITIVE_INFINITY);
    const device = await makeTestDevice();
    const answers: string[] = [];
    const Real = Worker;
    vi.stubGlobal(
      "Worker",
      class extends Real {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener("message", (event: MessageEvent<unknown>) => {
            const data = event.data;
            if (typeof data === "object" && data !== null && "type" in data && typeof data.type === "string") answers.push(data.type);
          });
        }
      },
    );
    const posts: string[] = [];
    const origPost = Worker.prototype.postMessage;
    // Forwarded as given (the relay passes a transfer list, the overload the spy's type does not name).
    const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message: unknown, options?: StructuredSerializeOptions) {
      if (typeof message === "object" && message !== null && "type" in message && typeof message.type === "string") posts.push(message.type);
      origPost.call(this, message, options);
    });
    const pipelines = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
    const order: string[] = [];
    const treesWhileCompiling: (LODTree | null)[] = [];
    const g = clustered(2000);
    const handle = startGpuLayout(
      device,
      g,
      { width: W, height: H, iterations: 20, lod: true },
      () => {},
      (tree) => {
        if (pipelines.mock.calls.length === 0) treesWhileCompiling.push(tree);
        order.push(tree ? "tree" : "no tree");
      },
      (t) => order.push(t),
    );
    try {
      // The worker coarsens while the programs compile, and answers before they have linked.
      expect(posts).toContain("coarsen");
      for (let i = 0; i < 600 && !answers.includes("lod-topology"); i++) await nextFrame();
      expect(answers).toContain("lod-topology");
      await nextFrame();
      expect(pipelines).toHaveBeenCalledTimes(0);
      expect(order).toEqual(["gpu"]);
      fake.release();
      await handle.settled;
      expect(treesWhileCompiling).toEqual([]);
      expect(order[0]).toBe("gpu");
      expect(order.filter((o) => o === "tree")).toHaveLength(1);
      expect(order).not.toContain("no tree");
    } finally {
      handle.stop();
      post.mockRestore();
      fake.restore();
      device.destroy();
    }
  });
});

describe("GPU nested layout programs compile in parallel, before the layout (#385)", () => {
  const tree = topo(threeLevel(4, 4, 12));

  it("issues every program once the prep is back, reports gpu, reads no link before completion, and builds once all linked", async () => {
    const fake = fakeParallelCompile(4);
    const device = await makeTestDevice();
    const proto = WebGL2RenderingContext.prototype;
    const programs = vi.spyOn(proto, "createProgram");
    const pipelines = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
    const transports: string[] = [];
    const handle = startGpuNestedLayout(device, graphOver(tree), tree, { iterations: 20 }, () => {}, { onTransport: (t) => transports.push(t) });
    try {
      const expected = uniquePrograms(nestedRunPrograms(device, tree, 20)).length;
      for (let i = 0; i < 600 && programs.mock.calls.length === 0; i++) await nextFrame(); // the prep, in a worker
      expect(programs).toHaveBeenCalledTimes(expected);
      expect(pipelines).toHaveBeenCalledTimes(0);
      expect(transports).toEqual(["gpu"]);
      expect(handle.transport).toBe("gpu");
      let pollFrames = 0;
      for (let i = 0; i < 2000 && pipelines.mock.calls.length === 0; i++) {
        const asked = fake.queries;
        await nextFrame();
        expect(fake.queries - asked).toBeLessThanOrEqual(expected);
        if (pipelines.mock.calls.length > 0) break;
        pollFrames++;
      }
      expect(pollFrames, "the build came before the fake reported every link complete").toBeGreaterThanOrEqual(3);
      await handle.settled;
      expect(fake.blocking, "a link status was read before its link completed").toBe(0);
      expect(transports).toEqual(["gpu"]);
    } finally {
      handle.stop();
      fake.restore();
      device.destroy();
    }
  });

  it("a stop during the compile frees every program and builds nothing", async () => {
    const fake = fakeParallelCompile(1_000_000);
    const device = await makeTestDevice();
    const proto = WebGL2RenderingContext.prototype;
    const programs = vi.spyOn(proto, "createProgram");
    const deletes = vi.spyOn(proto, "deleteProgram");
    const pipelines = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
    try {
      const handle = startGpuNestedLayout(device, graphOver(tree), tree, { iterations: 20 }, () => {});
      for (let i = 0; i < 600 && programs.mock.calls.length === 0; i++) await nextFrame();
      expect(programs.mock.calls.length).toBeGreaterThan(0);
      handle.stop();
      await handle.settled;
      const warmed = programs.mock.results.map((r) => r.value);
      for (const p of warmed) expect(deletes.mock.calls.some(([d]) => d === p)).toBe(true);
      await nextFrame();
      await nextFrame();
      expect(pipelines).toHaveBeenCalledTimes(0);
    } finally {
      fake.restore();
      device.destroy();
    }
  });

  it("a program that fails to link falls back to the worker with one warning", async () => {
    const fake = fakeParallelCompile(2, true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const device = await makeTestDevice();
    const transports: string[] = [];
    const handle = startGpuNestedLayout(device, graphOver(tree), tree, { iterations: 20 }, () => {}, { onTransport: (t) => transports.push(t) });
    try {
      await handle.settled;
      expect(transports).toEqual(["gpu", "worker"]);
      expect(handle.transport).toBe("worker");
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/fell back to the CPU worker: a GPU layout program failed to link/);
    } finally {
      handle.stop();
      fake.restore();
      device.destroy();
    }
  });

  it("a device whose float-blend probe already failed falls back before the prep, compiling nothing", async () => {
    const device = await makeTestDevice();
    const fbo = vi.spyOn(device, "createFramebuffer").mockImplementation(() => {
      throw new Error("framebuffer incomplete");
    });
    expect(gpuCaps(device)?.blendProbe).toBe("error");
    fbo.mockRestore();
    const fake = fakeParallelCompile(4);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const programs = vi.spyOn(WebGL2RenderingContext.prototype, "createProgram");
    const handle = startGpuNestedLayout(device, graphOver(tree), tree, { iterations: 20 }, () => {});
    try {
      expect(handle.transport).toBe("worker");
      await handle.settled;
      expect(programs).toHaveBeenCalledTimes(0);
    } finally {
      handle.stop();
      fake.restore();
      device.destroy();
    }
  });

  it("a context lost during the compile lays the map out on the worker, with one warning", async () => {
    const fake = fakeParallelCompile(1_000_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const device = await makeTestDevice();
    const programs = vi.spyOn(WebGL2RenderingContext.prototype, "createProgram");
    const pipelines = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
    const handle = startGpuNestedLayout(device, graphOver(tree), tree, { iterations: 20 }, () => {});
    try {
      for (let i = 0; i < 600 && programs.mock.calls.length === 0; i++) await nextFrame();
      const lost = vi.spyOn(WebGL2RenderingContext.prototype, "isContextLost").mockReturnValue(true);
      for (let i = 0; i < 200 && handle.transport !== "worker"; i++) await nextFrame();
      lost.mockRestore();
      expect(handle.transport).toBe("worker");
      expect(pipelines).toHaveBeenCalledTimes(0);
      await handle.settled;
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/the WebGL context was lost while the layout's programs compiled/);
    } finally {
      handle.stop();
      fake.restore();
      device.destroy();
    }
  });
});

describe("GPU layout startup: a render-backend swap or a lost context during the compile (#311, #385)", () => {
  it("a swap during the compile abandons it and builds on the next device", async () => {
    const fake = fakeParallelCompile(1_000_000);
    const first = await makeTestDevice();
    const proto = WebGL2RenderingContext.prototype;
    const programs = vi.spyOn(proto, "createProgram");
    const deletes = vi.spyOn(proto, "deleteProgram");
    const pipelines = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
    const transports: string[] = [];
    const handle = startGpuLayout(first, clustered(600), { width: W, height: H, iterations: 20 }, () => {}, undefined, (t) => transports.push(t));
    const second = await makeTestDevice();
    try {
      await nextFrame();
      const warmed = programs.mock.results.map((r) => r.value);
      expect(warmed.length).toBeGreaterThan(0);
      fake.release(); // the next device's compile completes at its first poll
      handle.moveDevice?.(Promise.resolve(second));
      await handle.settled;
      // The first device's compile was freed, and nothing was built on it.
      for (const p of warmed) expect(deletes.mock.calls.some(([d]) => d === p)).toBe(true);
      expect(pipelines.mock.contexts.some((device) => device === first)).toBe(false);
      expect(pipelines.mock.contexts.some((device) => device === second)).toBe(true);
      expect(handle.transport).toBe("gpu");
      expect(transports).toEqual(["gpu", "gpu"]);
    } finally {
      handle.stop();
      fake.restore();
      first.destroy();
      second.destroy();
    }
  });

  it("a context lost during the compile continues on the worker, with one warning", async () => {
    const fake = fakeParallelCompile(1_000_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const device = await makeTestDevice();
    const pipelines = vi.spyOn(WebGLDevice.prototype, "createRenderPipeline");
    const transports: string[] = [];
    const handle = startGpuLayout(device, clustered(600), { width: W, height: H, iterations: 20, warnUnsupported: false }, () => {}, undefined, (t) => transports.push(t));
    try {
      await nextFrame();
      const lost = vi.spyOn(WebGL2RenderingContext.prototype, "isContextLost").mockReturnValue(true);
      for (let i = 0; i < 200 && handle.transport !== "worker"; i++) await nextFrame();
      lost.mockRestore();
      expect(handle.transport).toBe("worker");
      expect(transports).toEqual(["gpu", "worker"]);
      expect(pipelines).toHaveBeenCalledTimes(0);
      await handle.settled;
      // A fault, so it warns even where the worker is expected ("auto").
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/the WebGL context was lost while the layout's programs compiled/);
    } finally {
      handle.stop();
      fake.restore();
      device.destroy();
    }
  });
});
