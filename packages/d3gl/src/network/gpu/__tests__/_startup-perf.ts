/**
 * The shared harness of the GPU layouts' startup guards at scale (#385): `gpu-startup-flat-perf.browser.test.ts`
 * and `gpu-startup-nested-perf.browser.test.ts` (one file per layout, each within the browser perf tier's 300 s per
 * file: a leg with LOD off draws the whole graph on SwiftShader every frame). See the flat file for what they pin.
 */
import { expect, vi } from "vitest";
import { network, type Network } from "../../network.js";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import type { ModuleNode } from "../../modules.js";
import { ProgramWarmup } from "../programs.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { GpuNestedLayout } from "../gpu-nested-layout.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";
import { sweepFrames, zoomSteps } from "../../../__tests__/engine-sweep.js";
import { fakeParallelCompile } from "./_parallel-compile.js";

export const LOCAL_N = 100_000;
export const N = perfN(LOCAL_N, { max: 1_000_000 });
export const W = 800;
export const H = 600;
/** `COMPLETION_STATUS_KHR`. */
const COMPLETION = 0x91b1;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * `n` leaves in modules of 100 (10 bottom modules per mid module, the rest top modules): a tree inside each bottom
 * module, one link into the leaf's mid module per leaf, and a cross-module link per 4 leaves.
 */
export function moduleGraph(n: number): { graph: NetworkGraph; modules: ModuleNode[] } {
  let s = 0x385;
  const rnd = (): number => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const L = 100;
  const source: number[] = [];
  const target: number[] = [];
  const modules: ModuleNode[] = [];
  for (let i = 0; i < n; i++) {
    const bottom = Math.floor(i / L);
    const mid = Math.floor(bottom / 10);
    modules.push({ id: i, path: [Math.floor(mid / 10) + 1, (mid % 10) + 1, (bottom % 10) + 1, (i % L) + 1] });
    const b0 = bottom * L;
    if (i > b0) {
      source.push(i);
      target.push(b0 + Math.floor(rnd() * (i - b0)));
    }
    source.push(i);
    target.push(Math.min(n - 1, mid * 10 * L + Math.floor(rnd() * 10 * L)));
    if (i % 4 === 0) {
      source.push(i);
      target.push(Math.floor(rnd() * n));
    }
  }
  return { graph: buildGraph({ nodeCount: n, source, target }), modules };
}

/** GL objects created and shader statuses read, counted on the live context (program queries: the fake's own counters). */
function glCounters(): { counts: () => Record<string, number>; restore: () => void } {
  const proto = WebGL2RenderingContext.prototype;
  const names = ["createTexture", "createFramebuffer", "createBuffer", "createProgram", "createShader", "getShaderParameter"] as const;
  const counts: Record<string, number> = {};
  const spies = names.map((name) => {
    counts[name] = 0;
    const orig = proto[name] as (...args: unknown[]) => unknown;
    return vi.spyOn(proto, name).mockImplementation(function (this: WebGL2RenderingContext, ...args: unknown[]) {
      counts[name] = (counts[name] ?? 0) + 1;
      return orig.apply(this, args);
    } as never);
  });
  return {
    counts: () => ({ ...counts }),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

export interface Leg {
  programs: number;
  pollFrames: number;
  /** Per poll frame: completion queries, other program queries, GL objects created, and ms inside the poll. */
  perFrame: { completion: number; other: number; created: number; pollMs: number }[];
  sweepBefore: number;
  sweepDuring: number;
  listAndIssueMs: number;
  /** Which solver listed the programs: "flat" or "nested" (the leg asserts it took the layout it meant). */
  listedBy: string;
}

export async function startupLeg(net: Network, graph: NetworkGraph, modules: ModuleNode[], nested: boolean, lod: boolean): Promise<Leg> {
  if (nested) net.data(graph, { modules });
  else net.data(graph);
  net.lod(lod ? {} : false);
  await net.whenReady();
  for (let i = 0; i < 2; i++) await nextFrame();
  const steps = zoomSteps(W, H);
  const apply = (t: { k: number; x: number; y: number }): void => {
    net.setTransform(t);
  };
  const sweepBefore = sweepFrames(steps, apply).worstFrameMs;
  net.setTransform({ k: 1, x: 0, y: 0 });

  // The compile is held (the fake reports no link complete) until the frames below are measured.
  const fake = fakeParallelCompile(Number.POSITIVE_INFINITY);
  let listAndIssueMs = 0;
  let programs = 0;
  const listFlat = GpuForceLayout.programs;
  const listNested = GpuNestedLayout.programs;
  const timed = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    const t0 = performance.now();
    try {
      return fn(...args);
    } finally {
      listAndIssueMs += performance.now() - t0;
    }
  };
  const flatSpy = vi.spyOn(GpuForceLayout, "programs").mockImplementation(timed(listFlat));
  const nestedSpy = vi.spyOn(GpuNestedLayout, "programs").mockImplementation(timed(listNested));
  const issue = ProgramWarmup.start;
  const startSpy = vi.spyOn(ProgramWarmup, "start").mockImplementation(
    timed((device, list) => {
      const warmup = issue.call(ProgramWarmup, device, list);
      programs = warmup?.count ?? 0;
      return warmup;
    }),
  );
  let pollMs = 0;
  const poll = ProgramWarmup.prototype.poll;
  const pollSpy = vi.spyOn(ProgramWarmup.prototype, "poll").mockImplementation(function (this: ProgramWarmup) {
    const t0 = performance.now();
    try {
      return poll.call(this);
    } finally {
      pollMs += performance.now() - t0;
    }
  });
  try {
    net.layout(nested ? { nested: true, backend: "gpu" } : { backend: "gpu" });
    // The nested layout issues its compile once its prep (a worker) is back.
    for (let i = 0; i < 3000 && programs === 0; i++) await nextFrame();
    expect(programs, "the run compiled its programs in parallel").toBeGreaterThan(0);
    const gl = glCounters();
    const perFrame: Leg["perFrame"] = [];
    let sweepDuring = 0;
    try {
      // Poll frames with a user's zoom on each: the same sweep, spread over animation frames.
      for (const t of steps) {
        const before = gl.counts();
        const queries = fake.queries;
        const blocking = fake.blocking;
        pollMs = 0;
        await nextFrame();
        const after = gl.counts();
        const created = ["createTexture", "createFramebuffer", "createBuffer", "createProgram", "createShader"].reduce(
          (sum, name) => sum + (after[name] ?? 0) - (before[name] ?? 0),
          0,
        );
        perFrame.push({
          completion: fake.queries - queries,
          // A status read of a program before its link completed (the fake's `blocking`), or of a shader.
          other: fake.blocking - blocking + (after["getShaderParameter"] ?? 0) - (before["getShaderParameter"] ?? 0),
          created,
          pollMs,
        });
        sweepDuring = Math.max(sweepDuring, sweepFrames([t], apply).worstFrameMs);
      }
    } finally {
      gl.restore();
    }
    expect(net.layoutTransport).toBe("gpu");
    const listedBy = nestedSpy.mock.calls.length > 0 ? "nested" : flatSpy.mock.calls.length > 0 ? "flat" : "none";
    return { programs, pollFrames: perFrame.length, perFrame, sweepBefore, sweepDuring, listAndIssueMs, listedBy };
  } finally {
    net.stopLayout();
    fake.restore();
    flatSpy.mockRestore();
    nestedSpy.mockRestore();
    startSpy.mockRestore();
    pollSpy.mockRestore();
  }
}

