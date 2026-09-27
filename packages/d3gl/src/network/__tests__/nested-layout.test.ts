import { describe, it, expect, vi } from "vitest";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import { Scratch, collide, nestedLayout, nestedRootBounds } from "../nested-layout.js";
import { BarnesHutTree } from "../quadtree.js";
import {
  expectNested,
  kids,
  linkTightness,
  meanShift,
  reclustered,
  rootOf,
  similar,
  spreadOf,
  threeLevel,
  topo,
  twoLevel,
} from "./nested-fixtures.js";
import { layoutBox, type FitBox } from "../fit.js";

describe("nestedLayout (#324)", () => {
  const { tree, nodeCount } = twoLevel();
  const out = nestedLayout(tree);
  const root = rootOf(tree);
  const [m1, m2, m3, m4] = kids(tree, root).sort((a, b) => a - b);
  const dist = (a: number, b: number): number => Math.hypot(out.cx[a]! - out.cx[b]!, out.cy[a]! - out.cy[b]!);

  it("returns a position for every leaf", () => {
    expect(out.positions).toHaveLength(2 * nodeCount);
    expect(Array.from(out.positions).every(Number.isFinite)).toBe(true);
  });

  it("keeps every child disc inside its parent's disc", () => {
    const parent = tree.parent!;
    for (let g = 0; g < tree.size; g++) {
      const p = parent[g]!;
      if (p < 0) continue;
      expect(dist(g, p) + out.r[g]!).toBeLessThanOrEqual(out.r[p]! * 1.0001);
    }
  });

  it("places each leaf inside all of its ancestors' discs", () => {
    const parent = tree.parent!;
    for (let i = 0; i < nodeCount; i++) {
      for (let g = parent[i]!; g >= 0; g = parent[g]!) {
        const d = Math.hypot(out.positions[2 * i]! - out.cx[g]!, out.positions[2 * i + 1]! - out.cy[g]!);
        expect(d).toBeLessThanOrEqual(out.r[g]!);
      }
    }
  });

  it("does not overlap sibling discs", () => {
    for (let g = tree.leafCount; g < tree.size; g++) {
      const c = kids(tree, g);
      for (let a = 0; a < c.length; a++) {
        for (let b = a + 1; b < c.length; b++) {
          expect(dist(c[a]!, c[b]!)).toBeGreaterThanOrEqual((out.r[c[a]!]! + out.r[c[b]!]!) * 0.98);
        }
      }
    }
  });

  it("places strongly linked siblings closer than weakly or unlinked ones", () => {
    expect(dist(m1!, m2!)).toBeLessThan(dist(m1!, m4!));
    expect(dist(m3!, m4!)).toBeLessThan(dist(m2!, m3!));
  });

  it("is deterministic", () => {
    expect(Array.from(nestedLayout(tree).positions)).toEqual(Array.from(out.positions));
  });

  it("sizes discs by the size metric", () => {
    const size = new Float32Array(nodeCount).fill(1);
    for (let j = 0; j < 6; j++) size[j] = 10; // module 1 gets 10× the metric of each other module
    const sized = nestedLayout(tree, { size });
    expect(sized.r[m1!]! / sized.r[m2!]!).toBeCloseTo(Math.sqrt(10), 1);
  });

  it("streams depths top-down, leaves collapsed to their placed ancestor", () => {
    const depths: number[] = [];
    let firstFrame: Float32Array | null = null;
    nestedLayout(tree, {
      onDepth: (depth, positions) => {
        depths.push(depth);
        firstFrame ??= positions.slice();
      },
    });
    expect(depths).toEqual([1, 2]);
    // After depth 1 every leaf of module 1 sits at module 1's centre.
    const frame = firstFrame as Float32Array | null;
    expect(frame?.[0]).toBeCloseTo(out.cx[m1!]!);
    expect(frame?.[10]).toBeCloseTo(out.cx[m1!]!);
  });
});

describe("nestedLayout Barnes-Hut repulsion (modules above the exact-sum size)", () => {
  it("walks each large module's tree once per step, in the tree's spatial order", () => {
    // 40 top modules of 2 chained leaves: the root solve has 40 children, above the O(k²) exact sum's
    // limit, so its repulsion goes through the Barnes-Hut tree; every 2-leaf module stays exact.
    const k = 40;
    const records: ModuleNode[] = [];
    const source: number[] = [];
    const target: number[] = [];
    const weight: number[] = [];
    for (let m = 0; m < k; m++) {
      records.push({ id: 2 * m, path: [m + 1, 1] }, { id: 2 * m + 1, path: [m + 1, 2] });
      source.push(2 * m);
      target.push(2 * m + 1);
      weight.push(1);
    }
    const tree = buildModuleLODTree(2 * k, records, { source, target, weight }, []);
    const walks = vi.spyOn(BarnesHutTree.prototype, "applyForces");
    const traversals = vi.spyOn(BarnesHutTree.prototype, "applyForce");
    const out = nestedLayout(tree);
    const steps = walks.mock.calls.length;
    const visits = traversals.mock.calls.length;
    walks.mockRestore();
    traversals.mockRestore();
    expect(steps, "the root solve's repulsion uses the tree").toBeGreaterThan(0);
    expect(visits, "every traversal comes from the Z-order walk, one per child per step").toBe(steps * k);
    expect(Array.from(out.positions).every(Number.isFinite)).toBe(true);
  });
});

describe("nestedLayout's streamed bound (#427): what a cold map's fit frames while its depths land", () => {
  const tree = threeLevel(12, 6, 10);
  const R = 10 * Math.sqrt(tree.leafCount);
  const bounds: FitBox[] = [];
  const out = nestedLayout(topo(tree), { onDepth: (_depth, _positions, box) => bounds.push([...box]) });
  const exact = layoutBox(out.positions, tree.leafCount);
  const side = (b: FitBox): number => Math.max(b[2] - b[0], b[3] - b[1]);

  it("is posted with every depth frame", () => {
    expect(bounds).toHaveLength(3); // top modules, sub-modules, leaves
  });

  it("holds every leaf's final position from the first depth on", () => {
    for (const [minX, minY, maxX, maxY] of bounds) {
      for (let i = 0; i < tree.leafCount; i++) {
        const x = out.positions[2 * i] ?? NaN;
        const y = out.positions[2 * i + 1] ?? NaN;
        expect(x >= minX && x <= maxX && y >= minY && y <= maxY, `leaf ${i} outside ${[minX, minY, maxX, maxY].join(", ")}`).toBe(true);
      }
    }
  });

  it("only shrinks, depth by depth — the camera only zooms in as depths land (#324)", () => {
    for (let d = 1; d < bounds.length; d++) {
      const [a, b] = [bounds[d - 1], bounds[d]];
      if (!a || !b) throw new Error("missing depth");
      expect(b[0]).toBeGreaterThanOrEqual(a[0]);
      expect(b[1]).toBeGreaterThanOrEqual(a[1]);
      expect(b[2]).toBeLessThanOrEqual(a[2]);
      expect(b[3]).toBeLessThanOrEqual(a[3]);
    }
  });

  it("ends as the leaves' exact box — the box a flat layout's fit frames (#347)", () => {
    expect(bounds[bounds.length - 1]).toEqual(exact);
  });

  it("is tighter than the root disc from the first depth on", () => {
    const first = bounds[0];
    if (!first || !exact) throw new Error("no bound");
    expect(side(first)).toBeLessThan(2 * R);
    expect(side(exact)).toBeLessThan(side(first));
  });

  it("starts inside the root disc: the bound a transport posts before any depth (nestedRootBounds)", () => {
    const root = nestedRootBounds(tree.leafCount);
    expect(root).toEqual([-R, -R, R, R]);
    expect(nestedRootBounds(tree.leafCount, 7)).toEqual([-7, -7, 7, 7]);
    const first = bounds[0];
    if (!first) throw new Error("no bound");
    expect(first[0] >= root[0] && first[1] >= root[1] && first[2] <= root[2] && first[3] <= root[3]).toBe(true);
  });
});

describe("nestedLayout warm start (#328)", () => {
  const tree = threeLevel(12, 6, 10);
  const R = 10 * Math.sqrt(tree.leafCount);
  const cold = nestedLayout(topo(tree));

  it("moves nodes little when warm-started from its own nested layout", () => {
    const warm = nestedLayout(topo(tree), { initial: cold.positions });
    // Measured 0.037·R. A cold re-solve from any other seed moves them ~0.75·R (see the rotation test).
    expect(meanShift(warm.positions, cold.positions)).toBeLessThan(0.06 * R);
    // …and repeated warm starts settle rather than drift: the second moves less than the first.
    const again = nestedLayout(topo(tree), { initial: warm.positions });
    expect(meanShift(again.positions, warm.positions)).toBeLessThan(meanShift(warm.positions, cold.positions));
    expectNested(tree, warm);
  });

  it("follows the current arrangement — a rotated map stays rotated, where a cold start ignores it", () => {
    const rotated = similar(cold.positions, Math.PI / 2);
    const warm = nestedLayout(topo(tree), { initial: rotated });
    expect(meanShift(warm.positions, rotated)).toBeLessThan(0.06 * R);
    expect(meanShift(cold.positions, rotated)).toBeGreaterThan(0.5 * R);
  });

  it("keeps the map where it is: the leaves keep their centroid and RMS spread", () => {
    const moved = similar(cold.positions, 1, 0.3, 500, -300); // rotated, shrunk and shifted
    const before = spreadOf(moved);
    const after = spreadOf(nestedLayout(topo(tree), { initial: moved }).positions);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    expect(after.rms / before.rms).toBeCloseTo(1, 4);
  });

  it("an explicit radius sizes the root disc; the centroid still follows the current map", () => {
    const moved = similar(cold.positions, 0, 1, 200, 100);
    const warm = nestedLayout(topo(tree), { initial: moved, radius: 50 });
    expect(warm.r[rootOf(tree)]).toBeCloseTo(50, 3);
    const after = spreadOf(warm.positions);
    const before = spreadOf(moved);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  it("is deterministic", () => {
    const initial = similar(cold.positions, 0.4);
    expect(Array.from(nestedLayout(topo(tree), { initial }).positions)).toEqual(Array.from(nestedLayout(topo(tree), { initial }).positions));
  });

  it("gives exactly the cold layout from all-coincident positions (a graph never laid out)", () => {
    const warm = nestedLayout(topo(tree), { initial: new Float32Array(2 * tree.leafCount) });
    expect(Array.from(warm.positions)).toEqual(Array.from(cold.positions));
    expect(Array.from(warm.r)).toEqual(Array.from(cold.r));
  });

  it("treats non-finite coordinates as unknown", () => {
    const initial = similar(cold.positions, 0.2);
    for (let i = 0; i < 40; i++) initial[2 * i] = Number.NaN; // the first four sub-modules' leaves
    initial[2 * 300 + 1] = Number.POSITIVE_INFINITY;
    expectNested(tree, nestedLayout(topo(tree), { initial }));
  });

  it("does not stream depths — they would collapse the leaves onto their module centres", () => {
    let frames = 0;
    nestedLayout(topo(tree), { initial: cold.positions, onDepth: () => frames++ });
    expect(frames).toBe(0);
  });

  it("keeps linked siblings closer after a warm start from the same hierarchy", () => {
    const { tree: small } = twoLevel();
    const warm = nestedLayout(topo(small), { initial: nestedLayout(topo(small)).positions });
    const [m1, m2, m3, m4] = kids(small, rootOf(small)).sort((a, b) => a - b);
    const dist = (a: number, b: number): number => Math.hypot(warm.cx[a]! - warm.cx[b]!, warm.cy[a]! - warm.cy[b]!);
    expect(dist(m1!, m2!)).toBeLessThan(dist(m1!, m4!));
    expect(dist(m3!, m4!)).toBeLessThan(dist(m2!, m3!));
    expectNested(small, warm);
  });

  it("re-clusters well: invariants hold and links pull as tight as in a cold layout", () => {
    const { flat, merged, split } = reclustered();
    const before = nestedLayout(topo(flat));
    for (const next of [merged, split]) {
      const warm = nestedLayout(topo(next), { initial: before.positions });
      const fresh = nestedLayout(topo(next));
      expectNested(next, warm);
      // Measured (warm vs cold): merged 0.887 vs 0.906, split 0.922 vs 0.934 — on par or tighter.
      expect(linkTightness(next, warm)).toBeLessThan(linkTightness(next, fresh) + 0.02);
      // …and it is a refinement: the leaves move less than a cold re-layout moves them.
      expect(meanShift(warm.positions, before.positions)).toBeLessThan(meanShift(fresh.positions, before.positions));
    }
  });
});

describe("collide: coincident sibling discs (#357)", () => {
  const PAD = 1.15; // solveModule's collision spacing
  const SMALL = 0.05;
  const LARGE = 0.1;
  const MIN = (SMALL + LARGE) * PAD; // the pair's collision distance

  /** A scratch value, NaN when out of range, so a bad index fails the numeric assertions. */
  const at = (a: Float64Array, i: number): number => a[i] ?? Number.NaN;

  /**
   * `k` discs in collide()'s scratch: `a` (small) and `b` (large) on the same point, at the centre of a
   * lattice square, and every other disc (small) on a unit lattice — out of everyone's reach, so only the
   * pair can move.
   */
  function coincidentPair(k: number, a: number, b: number, s = new Scratch()): Scratch {
    s.ensure(k, k);
    const side = Math.ceil(Math.sqrt(k));
    for (let i = 0; i < k; i++) {
      s.x[i] = i % side;
      s.y[i] = Math.floor(i / side);
      s.rad[i] = SMALL;
    }
    s.x[a] = s.x[b] = 1.5;
    s.y[a] = s.y[b] = 0.5;
    s.rad[b] = LARGE;
    return s;
  }

  const GRID = { path: "uniform grid (k > 32)", k: 40, a: 11, b: 29 };

  for (const { path, k, a, b } of [{ path: "exact loop (k ≤ 32)", k: 8, a: 2, b: 5 }, GRID]) {
    it(`separates them by exactly the collision distance, along a fixed direction — ${path}`, () => {
      const s = coincidentPair(k, a, b);
      const x0 = s.x.slice(0, k);
      const y0 = s.y.slice(0, k);
      collide(s, k, PAD);
      const dx = at(s.x, b) - at(s.x, a);
      const dy = at(s.y, b) - at(s.y, a);
      // Before #357 the pair ended `MIN · 1e9` apart (1.7e8 here), which collapsed the parent's composition.
      expect(Math.hypot(dx, dy)).toBeCloseTo(MIN, 12);
      // The direction is index-derived, from the lower index to the higher: (cos(a + b), sin(a + b)).
      expect(dx / MIN).toBeCloseTo(Math.cos(a + b), 12);
      expect(dy / MIN).toBeCloseTo(Math.sin(a + b), 12);
      // Split by size, as for any overlapping pair: the smaller disc moves more (area shares 4 : 1).
      const share = (LARGE * LARGE) / (SMALL * SMALL + LARGE * LARGE);
      expect(Math.hypot(at(s.x, a) - at(x0, a), at(s.y, a) - at(y0, a))).toBeCloseTo(MIN * share, 12);
      expect(Math.hypot(at(s.x, b) - at(x0, b), at(s.y, b) - at(y0, b))).toBeCloseTo(MIN * (1 - share), 12);
      // Nobody else moves.
      for (let i = 0; i < k; i++) {
        if (i === a || i === b) continue;
        expect(at(s.x, i)).toBe(at(x0, i));
        expect(at(s.y, i)).toBe(at(y0, i));
      }
    });

  }

  it(`gives the same result on a scratch reused from a larger module — ${GRID.path}`, () => {
    // solveModule reuses one Scratch for every module, so the grid's cell heads and chains hold the previous
    // module's state. Resolve a larger coincident module first. Grid path only: the exact loop reads nothing
    // but x, y and rad, which coincidentPair rewrites, so a stale scratch cannot reach it.
    const { k, a, b } = GRID;
    const reused = coincidentPair(64, 7, 50);
    collide(reused, 64, PAD);
    coincidentPair(k, a, b, reused);
    collide(reused, k, PAD);
    const fresh = coincidentPair(k, a, b);
    collide(fresh, k, PAD);
    expect(Array.from(reused.x.subarray(0, k))).toEqual(Array.from(fresh.x.subarray(0, k)));
    expect(Array.from(reused.y.subarray(0, k))).toEqual(Array.from(fresh.y.subarray(0, k)));
  });
});
