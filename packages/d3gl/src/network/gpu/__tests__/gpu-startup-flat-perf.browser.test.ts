/**
 * The GPU layouts' parallel program compile at scale (#385), through the real trigger:
 * `network().layout({ backend: "gpu" })`, LOD off **and** on — the flat layout here, `nested` in
 * `gpu-startup-nested-perf.browser.test.ts` (the same harness, `_startup-perf.ts`).
 *
 * While a run's programs compile (1-2 s on ANGLE Metal with a cold shader cache), the transport polls them once
 * per animation frame, and the user may pan and zoom meanwhile. That poll is per-frame work, so per AGENTS.md
 * §5 it is pinned at a large input in both reduction states:
 *
 * - **Deterministic signature, per animation frame of the compile:** at most one completion query
 *   (`COMPLETION_STATUS_KHR`) per program the run compiles, no other program or shader query (a link status read
 *   before completion would block), and no GL object created (texture, framebuffer, buffer, program, shader).
 *   The poll is O(programs): the count does not grow with N.
 * - **The zoom a user drives meanwhile:** a `setTransform` sweep during the compile costs what the same sweep
 *   costs before `layout()` (fastest rep per step, `sweepFrames`), within 1.5× + 2 ms — the compile adds nothing
 *   to the draw path. And the poll's own time per frame (inside `ProgramWarmup.poll`) stays under a ceiling that
 *   does not scale with N.
 * - **The click's one-off listing and issue:** the run's program list and the compile's issue (inside
 *   `layout()`'s task for the flat layout, once the prep is back for the nested one) stay under `c0 + c1·N`:
 *   the flat list reads the graph's degrees (O(nodes), no allocation), the nested one counts the plan's links.
 *
 * The headless shell (SwiftShader) has no `KHR_parallel_shader_compile`, so the extension is faked
 * (`_parallel-compile.ts`) and held until the frames are measured; the real compile is measured on hardware (the
 * PR's A/B). One engine per leg: a device compiles a program set once, and each leg must compile.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { network } from "../../network.js";
import { perfBudget } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";
import { H, LOCAL_N, N, W, moduleGraph, startupLeg } from "./_startup-perf.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe(`GPU flat layout startup at scale (#385): the parallel compile's poll frames, N=${N.toLocaleString()} leaves`, () => {
  const { graph, modules } = moduleGraph(N);
  // Calibrated at LOCAL_N on SwiftShader: the listing + issue measured 2.6-4.7 ms there (flat and nested).
  const LIST_ISSUE_MS = perfBudget(40 + 40 * (N / LOCAL_N));
  // The poll asks one query per program per frame (tens of programs): well under a millisecond anywhere.
  const POLL_MS = perfBudget(2);

  for (const lod of [false, true]) {
    const name = `flat, LOD ${lod ? "on" : "off"}`;
    it(`${name}: each poll frame is O(programs), creates nothing, and a zoom during the compile costs what it did before`, async () => {
      const host = perfHost(W, H);
      const net = network(host, { width: W, height: H, backend: "webgl" });
      try {
        const r = await startupLeg(net, graph, modules, false, lod);
        const worstPoll = Math.max(...r.perFrame.map((f) => f.pollMs));
        console.log(
          `  GPU startup [${name}] N=${N}: ${r.programs} programs (listed by ${r.listedBy}) compiled in parallel; per poll frame completion queries ` +
            `${r.perFrame.map((f) => f.completion).join(",")}, poll ms max ${worstPoll.toFixed(2)}; zoom worst frame ${r.sweepBefore.toFixed(1)} ms ` +
            `before, ${r.sweepDuring.toFixed(1)} ms during the compile; list + issue ${r.listAndIssueMs.toFixed(1)} ms`,
        );
        expect(r.listedBy, "the run is the layout the leg asked for").toBe("flat");
        expect(r.pollFrames).toBeGreaterThan(0);
        for (const f of r.perFrame) {
          expect(f.completion, "at most one completion query per program per frame").toBeLessThanOrEqual(r.programs);
          expect(f.other, "no link or compile status read while compiling").toBe(0);
          expect(f.created, "no GL object created by a poll frame").toBe(0);
        }
        expect(worstPoll).toBeLessThan(POLL_MS);
        expect(r.sweepDuring).toBeLessThan(1.5 * r.sweepBefore + perfBudget(2));
        expect(r.listAndIssueMs).toBeLessThan(LIST_ISSUE_MS);
      } finally {
        net.destroy();
        host.remove();
      }
    }, 240_000);
  }
});
