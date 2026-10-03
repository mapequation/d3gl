/**
 * The GPU nested solve's collision plan on a module of very uneven child sizes (#380; a single-scale grid
 * made its gather quadratic, 157 ms frames at 60,000 children), on the Zipf module of
 * `gpu-nested-zipf-perf.browser.test.ts`: a collision step's pair work stays within 3× of the collision
 * plan's estimate with no slot on the exact fallback, at every compact step of a full solve, and the gather
 * is cut into bands of equal estimated work. `gpu-nested-perf.browser.test.ts` lists what the nested guards
 * pin. A file of its own for the browser perf tier's 300 s per file (#460): a full solve of the 60,000-child
 * module with the per-slot statistics took about 145 s of that file's 180-250 s on CI.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Device } from "@luma.gl/core";
import type { NetworkGraph } from "../../graph.js";
import type { ModuleNode } from "../../modules.js";
import { GpuNestedLayout, nestedLayoutPlan } from "../gpu-nested-layout.js";
import { makeTestDevice } from "./_device.js";
import { perfBudget } from "../../../__tests__/perf-budget.js";
import { ITERATIONS, ZIPF_BIG, solverOf, zipfLike } from "./_nested-perf.js";

describe("GPU nested solve on a module of very uneven child sizes: the collision plan (#380)", () => {
  const BIG = ZIPF_BIG;
  let fixture: { graph: NetworkGraph; modules: ModuleNode[] };
  let device: Device;

  beforeAll(async () => {
    fixture = zipfLike(BIG);
    device = await makeTestDevice();
  });

  it("a collision step's pair work stays within 3× of the collision plan's estimate, with no slot on the exact fallback", () => {
    const solver = solverOf(fixture, ITERATIONS);
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver), { collisionStats: true });
    try {
      layout.runTicks(Math.ceil(0.6 * ITERATIONS));
      const ratios: number[] = [];
      while (layout.ticks < ITERATIONS) {
        layout.beginTick();
        const stats = layout.collisionStats();
        let work = 0;
        let overflow = 0;
        for (let i = 0; i < solver.slotCount; i++) {
          work += 16 * (stats[4 * i] ?? 0) + (stats[4 * i + 1] ?? 0);
          if (stats[4 * i + 3] === 2) overflow++;
        }
        expect(overflow, `tick ${layout.ticks}: slots sent to the exact fallback`).toBe(0);
        ratios.push(work / solver.collision.gatherWork);
        layout.forceBand(0, 1);
        layout.integrate();
      }
      console.log(`  Zipf ${BIG}: pair work per collision step / plan estimate: ${Math.min(...ratios).toFixed(2)}-${Math.max(...ratios).toFixed(2)} (single-scale grid at 60,000 children: 36)`);
      expect(Math.max(...ratios)).toBeLessThan(3);
    } finally {
      layout.destroy();
    }
  }, perfBudget(300_000));

  it("cuts the gather into bands of equal estimated work, which rows alone would not", () => {
    // The frame budget admits a band by its share of the gather's estimate; a band must carry that share.
    // Rows alone would not: the big module's slots sit in the first rows.
    const solver = solverOf(fixture, ITERATIONS);
    const layout = new GpuNestedLayout(device, nestedLayoutPlan(solver));
    try {
      const width = Math.max(1, Math.ceil(Math.sqrt(solver.slotCount)));
      const rows = Math.ceil(solver.slotCount / width);
      const rowWork = (r0: number, r1: number): number => {
        let w = 0;
        for (let i = r0 * width; i < Math.min(solver.slotCount, r1 * width); i++) w += (solver.collision.slotWork[i] ?? 0) + 16;
        return w;
      };
      const total = rowWork(0, rows);
      let widestRow = 0;
      for (let r = 0; r < rows; r++) widestRow = Math.max(widestRow, rowWork(r, r + 1));
      for (const bands of [2, 4, 8]) {
        let next = 0;
        const shares: string[] = [];
        for (let b = 0; b < bands; b++) {
          const [r0, r1] = layout.gatherBandRows(b, bands);
          expect(r0).toBe(next);
          next = r1;
          const share = rowWork(r0, r1) / total;
          shares.push(share.toFixed(3));
          expect(share, `band ${b} of ${bands}`).toBeLessThanOrEqual(1 / bands + widestRow / total);
        }
        expect(next).toBe(rows);
        const firstEqualRows = rowWork(0, Math.floor(rows / bands)) / total;
        console.log(`  Zipf ${BIG}, ${bands} bands: work shares ${shares.join(" / ")} (the first of ${bands} equal-row bands: ${firstEqualRows.toFixed(3)})`);
      }
    } finally {
      layout.destroy();
    }
  });
});
