/**
 * The GPU nested layout's parallel program compile at scale (#385), through the real trigger:
 * `network().data(graph, { modules }).layout({ backend: "gpu", nested: true })`, LOD off **and** on. The compile
 * starts once the solve's prep is back from its worker. What it pins: `gpu-startup-flat-perf.browser.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { network } from "../../network.js";
import { perfBudget } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";
import { H, LOCAL_N, N, N_LOD_OFF, W, moduleGraph, startupLeg } from "./_startup-perf.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe(`GPU nested layout startup at scale (#385): the parallel compile's poll frames, N=${N.toLocaleString()} leaves (LOD off: ${N_LOD_OFF.toLocaleString()})`, () => {
  const maps = { on: moduleGraph(N), off: N_LOD_OFF === N ? null : moduleGraph(N_LOD_OFF) };
  // Calibrated at LOCAL_N on SwiftShader: the listing + issue measured 2.6-4.7 ms there (flat and nested).
  const listIssueMs = (n: number): number => perfBudget(40 + 40 * (n / LOCAL_N));
  // The poll asks one query per program per frame (tens of programs): well under a millisecond anywhere.
  const POLL_MS = perfBudget(2);

  for (const lod of [false, true]) {
    const { graph, modules } = (lod ? maps.on : maps.off) ?? maps.on;
    const name = `nested, LOD ${lod ? "on" : "off"}`;
    it(`${name}: each poll frame is O(programs), creates nothing, and a zoom during the compile costs what it did before`, async () => {
      const host = perfHost(W, H);
      const net = network(host, { width: W, height: H, backend: "webgl" });
      try {
        const r = await startupLeg(net, graph, modules, true, lod);
        const worstPoll = Math.max(...r.perFrame.map((f) => f.pollMs));
        console.log(
          `  GPU startup [${name}] N=${graph.nodeCount}: ${r.programs} programs (listed by ${r.listedBy}) compiled in parallel; per poll frame completion queries ` +
            `${r.perFrame.map((f) => f.completion).join(",")}, poll ms max ${worstPoll.toFixed(2)}; zoom worst frame ${r.sweepBefore.toFixed(1)} ms ` +
            `before, ${r.sweepDuring.toFixed(1)} ms during the compile; list + issue ${r.listAndIssueMs.toFixed(1)} ms`,
        );
        expect(r.listedBy, "the run is the layout the leg asked for").toBe("nested");
        expect(r.pollFrames).toBeGreaterThan(0);
        for (const f of r.perFrame) {
          expect(f.completion, "at most one completion query per program per frame").toBeLessThanOrEqual(r.programs);
          expect(f.other, "no link or compile status read while compiling").toBe(0);
          expect(f.created, "no GL object created by a poll frame").toBe(0);
        }
        expect(worstPoll).toBeLessThan(POLL_MS);
        expect(r.sweepDuring).toBeLessThan(1.5 * r.sweepBefore + perfBudget(2));
        expect(r.listAndIssueMs).toBeLessThan(listIssueMs(graph.nodeCount));
      } finally {
        net.destroy();
        host.remove();
      }
    }, 240_000);
  }
});
