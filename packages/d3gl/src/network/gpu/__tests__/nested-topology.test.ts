/**
 * The CPU prep of the batched GPU nested layout (#355): slots, segments, per-slot data and links — the
 * same problem the CPU `nestedLayout` solves, laid out for one segmented solve.
 */
import { describe, expect, it } from "vitest";
import { EXACT_MAX, Scratch, WARM_ALPHA, nestedLayout, setupModule, subtreeWeights } from "../../nested-layout.js";
import { NESTED_LARGE_MAX, nestedSolverBuffers, nestedSolverResult, nestedSolverTopology } from "../nested-topology.js";
import { assertSegmentLocalEdges, slotSegments } from "../segments.js";
import { threeLevel, topo } from "../../__tests__/nested-fixtures.js";
import { buildModuleLODTree, type ModuleNode } from "../../modules.js";

describe("nestedSolverTopology — one segmented solve over a module tree (#355)", () => {
  const tree = topo(threeLevel(3, 40, 5)); // 3 top modules × 40 sub-modules (> EXACT_MAX children) × 5 leaves
  const solver = nestedSolverTopology(tree, { iterations: 50 });
  const S = solver.segStart.length;

  it("has a slot for every non-root tree node, each in its parent's segment, in children-CSR order", () => {
    expect(solver.slotCount).toBe(tree.size - 1);
    expect(solver.nodeSlot[solver.root]).toBe(-1);
    for (let slot = 0; slot < solver.slotCount; slot++) expect(solver.nodeSlot[solver.slotNode[slot] ?? 0]).toBe(slot);
    for (let s = 0; s < S; s++) {
      const g = solver.segModule[s] ?? 0;
      const first = tree.childOffset[g] ?? 0;
      expect(solver.segCount[s]).toBe((tree.childOffset[g + 1] ?? 0) - first);
      for (let i = 0; i < (solver.segCount[s] ?? 0); i++) {
        expect(solver.slotNode[(solver.segStart[s] ?? 0) + i]).toBe(tree.children[first + i]);
      }
      // The composition walks each segment's owner — its parent module's own slot.
      expect(solver.segOwner[s]).toBe(solver.nodeSlot[g]);
    }
  });

  it("sorts segments by (parent depth, parent id), so each depth's slots are contiguous", () => {
    const depthOf = (g: number): number => {
      let d = 0;
      for (let p = tree.parent[g] ?? -1; p >= 0; p = tree.parent[p] ?? -1) d++;
      return d;
    };
    for (let s = 1; s < S; s++) {
      const a = solver.segModule[s - 1] ?? 0;
      const b = solver.segModule[s] ?? 0;
      expect(depthOf(a) < depthOf(b) || (depthOf(a) === depthOf(b) && a < b)).toBe(true);
      expect(solver.segStart[s]).toBe((solver.segStart[s - 1] ?? 0) + (solver.segCount[s - 1] ?? 0));
    }
    expect(solver.depth).toBe(3);
  });

  it("gives each slot the CPU module setup's radius and seed, and its links in slot ids", () => {
    const { weight } = subtreeWeights(tree, undefined);
    const scratch = new Scratch();
    let links = 0;
    for (let s = 0; s < S; s++) {
      const g = solver.segModule[s] ?? 0;
      const k = solver.segCount[s] ?? 0;
      if (k < 2) continue;
      const setup = setupModule(tree, g, tree.childOffset[g] ?? 0, tree.childOffset[g + 1] ?? 0, weight, 0.45, scratch, null);
      const base = solver.segStart[s] ?? 0;
      for (let i = 0; i < k; i++) {
        expect(solver.radius[base + i]).toBe(Math.fround(scratch.rad[i] ?? 0));
        expect(solver.seed[2 * (base + i)]).toBe(Math.fround(scratch.x[i] ?? 0));
        expect(solver.seed[2 * (base + i) + 1]).toBe(Math.fround(scratch.y[i] ?? 0));
      }
      for (let l = 0; l < setup.la.length; l++) {
        expect(solver.linkSource[links]).toBe(base + (setup.la[l] ?? 0));
        expect(solver.linkTarget[links]).toBe(base + (setup.lb[l] ?? 0));
        expect(solver.linkWeight[links]).toBe(Math.fround(setup.lw[l] ?? 0));
        links++;
      }
    }
    expect(solver.linkSource.length).toBe(links);
    // Sibling links never cross segments: the solver's isolation holds by construction.
    const segs = Array.from(solver.segStart, (start, s) => ({ start, count: solver.segCount[s] ?? 0 }));
    expect(() =>
      assertSegmentLocalEdges(slotSegments(segs, solver.slotCount), solver.linkSource, solver.linkTarget, links),
    ).not.toThrow();
  });

  it("marks lone children (k = 1) with no radius, seed or links: the composition places them itself", () => {
    // Module 1 has a single sub-module (1:1) holding 6 leaves; module 2 has two sub-modules.
    const records: ModuleNode[] = [];
    for (let id = 0; id < 12; id++) records.push({ id, path: id < 6 ? [1, 1, id + 1] : [2, (id % 2) + 1, id] });
    const t = topo(buildModuleLODTree(12, records, { source: [0, 6], target: [1, 7], weight: [1, 1] }));
    const single = nestedSolverTopology(t, {});
    let lone = 0;
    for (let s = 0; s < single.segStart.length; s++) {
      if ((single.segCount[s] ?? 0) !== 1) continue;
      lone++;
      const slot = single.segStart[s] ?? 0;
      expect(single.radius[slot]).toBe(0);
      expect(single.seed[2 * slot]).toBe(0);
      expect(single.seed[2 * slot + 1]).toBe(0);
      expect(Array.from(single.linkSource).includes(slot) || Array.from(single.linkTarget).includes(slot)).toBe(false);
    }
    expect(lone).toBe(1);
    expect(single.segAlpha0.every((a) => a === 1)).toBe(true);
  });

  it("lists each large segment's r₉ and its at most 8 larger slots", () => {
    const flow = new Float32Array(tree.leafCount);
    for (let i = 0; i < flow.length; i++) flow[i] = 1 + ((i * 7919) % 97) ** 2; // uneven sub-module weights
    const sized = nestedSolverTopology(tree, { size: flow });
    let checked = 0;
    for (let s = 0; s < sized.segStart.length; s++) {
      const k = sized.segCount[s] ?? 0;
      const large = Array.from(sized.segLarge.subarray(s * NESTED_LARGE_MAX, (s + 1) * NESTED_LARGE_MAX)).filter((x) => x >= 0);
      if (k <= EXACT_MAX) {
        expect(large).toEqual([]);
        continue;
      }
      checked++;
      const base = sized.segStart[s] ?? 0;
      const radii = Array.from(sized.radius.subarray(base, base + k)).sort((a, b) => b - a);
      const r9 = sized.segR9[s] ?? 0;
      expect(r9).toBe(radii[NESTED_LARGE_MAX]);
      for (let i = base; i < base + k; i++) expect(large.includes(i)).toBe((sized.radius[i] ?? 0) > r9);
    }
    expect(checked).toBe(3);
  });

  it("marks a slot large exactly when the collision shader will: its float32 radius above the float32 r₉", () => {
    // One top module of 40 sub-modules (> EXACT_MAX) of 2 leaves. Eight sub-modules weigh 1 + 1e-9 (a leaf
    // of 1e-9 added in float64), the ninth 1: their radii differ in float64 but round to one float32, which
    // is all the cell pass sees (r > r₉ in float32). A slot marked large there would also be binned into
    // the grid, and its neighbours would push it twice.
    const records: ModuleNode[] = [];
    const flow: number[] = [];
    for (let m = 0; m < 40; m++) {
      for (let j = 0; j < 2; j++) {
        records.push({ id: records.length, path: [1, m + 1, j + 1] });
        flow.push(m < 8 ? (j === 0 ? 1 : 1e-9) : m === 8 ? (j === 0 ? 1 : 0) : 0.1);
      }
    }
    const t = topo(buildModuleLODTree(records.length, records));
    const size = Float32Array.from(flow);
    const sized = nestedSolverTopology(t, { size });
    const s = Array.from(sized.segCount).findIndex((k) => k === 40);
    expect(s).toBeGreaterThanOrEqual(0);
    const base = sized.segStart[s] ?? 0;
    // The precondition: in float64 eight radii exceed r₉, in float32 none does.
    const { weight } = subtreeWeights(t, size);
    const scratch = new Scratch();
    const g = sized.segModule[s] ?? 0;
    setupModule(t, g, t.childOffset[g] ?? 0, t.childOffset[g + 1] ?? 0, weight, 0.45, scratch, null);
    const rad64 = Array.from(scratch.rad.subarray(0, 40));
    const r9 = rad64.slice().sort((a, b) => b - a)[NESTED_LARGE_MAX] ?? 0;
    expect(rad64.filter((r) => r > r9).length).toBe(8);
    expect(rad64.filter((r) => Math.fround(r) > Math.fround(r9)).length).toBe(0);
    // So no slot is large: the grid bins them all (cells of 2 · r₉ · PAD cover them).
    expect(sized.segR9[s]).toBe(Math.fround(r9));
    expect(Array.from(sized.segLarge.subarray(s * NESTED_LARGE_MAX, (s + 1) * NESTED_LARGE_MAX))).toEqual(new Array(NESTED_LARGE_MAX).fill(-1));
    for (let i = base; i < base + 40; i++) expect((sized.radius[i] ?? 0) > (sized.segR9[s] ?? 0)).toBe(false);
  });

  it("starts warm-seeded segments at WARM_ALPHA and records where the result goes", () => {
    const cold = nestedLayout(tree);
    const warm = nestedSolverTopology(tree, { initial: cold.positions });
    expect(solver.place).toBeNull();
    expect(warm.place).not.toBeNull();
    expect(Array.from(warm.segAlpha0).some((a) => a === Math.fround(WARM_ALPHA))).toBe(true);
    // All-coincident positions (a graph never laid out) are the cold layout.
    const never = nestedSolverTopology(tree, { initial: new Float32Array(2 * tree.leafCount) });
    expect(never.place).toBeNull();
    expect(never.segAlpha0.every((a) => a === 1)).toBe(true);
  });

  it("nestedSolverResult places a warm result over the current map like the CPU (centroid and spread)", () => {
    const cold = nestedLayout(tree);
    const initial = cold.positions.map((v, i) => v * 0.5 + (i % 2 ? -300 : 200));
    const warm = nestedSolverTopology(tree, { initial });
    // Any positions and discs: the placement is a similarity transform onto the initial map's spread.
    const positions = cold.positions.slice();
    const discs = new Float32Array(4 * (tree.size - tree.leafCount));
    const out = nestedSolverResult(warm, positions, discs, initial, true);
    let mx = 0;
    let my = 0;
    let ix = 0;
    let iy = 0;
    for (let i = 0; i < tree.leafCount; i++) {
      mx += out.positions[2 * i] ?? 0;
      my += out.positions[2 * i + 1] ?? 0;
      ix += initial[2 * i] ?? 0;
      iy += initial[2 * i + 1] ?? 0;
    }
    expect(mx / tree.leafCount).toBeCloseTo(ix / tree.leafCount, 2);
    expect(my / tree.leafCount).toBeCloseTo(iy / tree.leafCount, 2);
    // A cold result passes through untouched.
    const same = cold.positions.slice();
    nestedSolverResult(solver, same, discs, undefined, true);
    expect(Array.from(same)).toEqual(Array.from(cold.positions));
  });

  it("hands a worker its typed arrays' buffers to transfer", () => {
    const buffers = nestedSolverBuffers(solver);
    expect(buffers).toHaveLength(14);
    expect(new Set(buffers).size).toBe(14);
  });
});
