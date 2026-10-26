import { describe, expect, it } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import {
  buildLODTree,
  buildMortonLODTree,
  computeLODCrowding,
  computeLODGeometry,
  crowdingOptionsOf,
  cut,
  declutterFrontier,
  lodSpacing,
  type LODTransform,
  type LODTree,
} from "../lod.js";
import { buildModuleLODTree } from "../modules.js";
import { sierpinski } from "./sierpinski-fixture.js";

/**
 * #561 — the LOD cut treats every glyph as `declutterSpacing` times its size, the expand threshold with it, so the
 * cut at zoom `k` is the spacing-1 cut at `k / spacing` and the declutter keeps every glyph the cut opens wherever
 * spacing 1 keeps them. Before, the cut opened at overlap (spacing 1) and the default declutter (spacing 2, #468)
 * hid what it opened, with every link touching it: the Modular level of detail example drew no links at its
 * opening view.
 */

const W = 760;
const H = 520;
const R = 6; // the example's nodeRadius (screen px)
const EXPAND_PX = 120;
const MAX_AGG = 26;

/** The example's tree — the gasket's module hierarchy, screen radii — with its crowding at `spacing`. */
function gasketTree(spacing: number): LODTree {
  const { graph, modules } = sierpinski(4);
  const tree = buildModuleLODTree(graph.nodeCount, modules);
  computeLODGeometry(tree, graph, new Float32Array(graph.nodeCount).fill(R), graph.strength);
  computeLODCrowding(tree, crowdingOptionsOf(tree, { screenSized: true, expandPx: EXPAND_PX, spacing }));
  return tree;
}

/** The cut and the declutter at `spacing`, as the engine runs them. */
function frontierAt(tree: LODTree, t: LODTransform, spacing: number, w = W, h = H): { drawn: Uint32Array; kept: Uint32Array } {
  const drawn = cut(tree, t, w, h, { expandPx: EXPAND_PX, spacing, screenSized: true, maxAggregateRadius: MAX_AGG }).slice();
  const kept = declutterFrontier(tree, drawn, t, w, h, { screenSized: true, k: t.k, maxAggregateRadius: MAX_AGG, spacing }).slice();
  return { drawn, kept };
}

describe("the LOD cut at the declutter spacing (#561)", () => {
  it("the default spacing is the declutter's, and 1 without declutter or below 1", () => {
    expect(lodSpacing(undefined, undefined)).toBe(2);
    expect(lodSpacing(true, 3)).toBe(3);
    expect(lodSpacing(false, 3)).toBe(1);
    expect(lodSpacing(undefined, 0.5)).toBe(1); // below 1 the cut stays at 1: only the declutter thins less
    expect(lodSpacing(undefined, 0)).toBe(1);
    expect(lodSpacing(undefined, Infinity)).toBe(1);
  });

  it("below spacing 1 the cut stays as at 1: where 1 thins nothing neither does any spacing below it, and 0 hides nothing", () => {
    const tree = gasketTree(1); // the cut and its crowding at lodSpacing(_, s < 1) = 1
    for (const k of [0.3, 0.54, 0.8, 1.3, 1.9]) {
      const t = { k, x: W / 2 - 500 * k, y: H / 2 - 433 * k };
      const drawn = cut(tree, t, W, H, { expandPx: EXPAND_PX, spacing: 1, screenSized: true, maxAggregateRadius: MAX_AGG }).slice();
      const keptAt = (spacing: number): Set<number> => new Set(declutterFrontier(tree, drawn, t, W, H, { screenSized: true, k, maxAggregateRadius: MAX_AGG, spacing }));
      const one = keptAt(1);
      for (const s of [0.9, 0.5, 0.1]) for (const g of one) expect(keptAt(s).has(g), `k = ${k}, spacing ${s} keeps what 1 keeps`).toBe(true);
      expect(keptAt(0).size, `k = ${k}: spacing 0 hides nothing`).toBe(drawn.length);
    }
  });

  it("never thins the example's gasket, at any zoom of its range, centred or panned, at the default spacing and others", () => {
    for (const spacing of [lodSpacing(undefined, undefined), 1, 3]) {
      const tree = gasketTree(spacing);
      let refinements = 0;
      let previous = 0;
      for (let k = 0.15; k <= 22; k *= 1.06) {
        for (const [dx, dy] of [[0, 0], [180, -90], [-240, 120]] as const) {
          const { drawn, kept } = frontierAt(tree, { k, x: W / 2 - (500 - dx) * k, y: H / 2 - (433 - dy) * k }, spacing);
          expect(kept.length, `spacing ${spacing}, k = ${k.toFixed(3)}, pan (${dx}, ${dy}): declutter hid ${drawn.length - kept.length} of ${drawn.length}`).toBe(drawn.length);
        }
        const n = frontierAt(tree, { k, x: W / 2 - 500 * k, y: H / 2 - 433 * k }, spacing).drawn.length;
        if (n > previous) refinements++;
        previous = n;
      }
      expect(refinements, `spacing ${spacing}: the frontier refines as the view zooms in (not vacuous)`).toBeGreaterThanOrEqual(4);
    }
  });

  it("draws the example's opening view as the 9 second-level modules, each kept, at the default spacing", () => {
    const tree = gasketTree(2);
    const k = Math.min(W / 1000, H / 866) * 0.9; // the example's fit
    const { drawn, kept } = frontierAt(tree, { k, x: W / 2 - 500 * k, y: H / 2 - 433 * k }, 2);
    expect(drawn.length).toBe(9);
    expect(kept.length).toBe(9);
  });

  it("is the spacing-1 cut and declutter at k / spacing, on every tree kind", () => {
    function rng(seed: number): () => number {
      let s = seed >>> 0;
      return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    }
    const n = 1500;
    const r = rng(7);
    const source = Uint32Array.from({ length: n - 1 }, (_, i) => i + 1);
    const target = Uint32Array.from({ length: n - 1 }, (_, i) => Math.floor(r() * (i + 1)));
    const graph: NetworkGraph = buildGraph({ nodeCount: n, source, target });
    for (let i = 0; i < n; i++) {
      const c = i % 9;
      graph.positions[2 * i] = (c % 3) * 400 + (r() - 0.5) * 260;
      graph.positions[2 * i + 1] = Math.floor(c / 3) * 400 + (r() - 0.5) * 260;
    }
    const radii = Float32Array.from({ length: n }, () => 1 + r() * 5);
    const modules = Array.from({ length: n }, (_, id) => ({ id, path: [(id % 9) + 1, (Math.floor(id / 9) % 6) + 1, Math.floor(id / 54) + 1] }));
    const trees: [string, () => LODTree][] = [
      ["spatial", () => buildMortonLODTree(graph.positions, n)],
      ["structure", () => buildLODTree(graph)],
      ["modules", () => buildModuleLODTree(n, modules)],
    ];
    const ids = (a: Uint32Array): number[] => Array.from(a).sort((x, y) => x - y);
    let compared = 0;
    for (const [name, build] of trees) {
      for (const spacing of [2, 3]) {
        const one = build();
        const scaled = build();
        for (const [tree, s] of [[one, 1], [scaled, spacing]] as const) {
          computeLODGeometry(tree, graph, radii, graph.strength);
          computeLODCrowding(tree, crowdingOptionsOf(tree, { screenSized: true, expandPx: 48, spacing: s }));
        }
        // A view far larger than the layout, so neither cut culls (a glyph's cull margin is its drawn size).
        const big = 1e5;
        for (const k of [0.02, 0.05, 0.13, 0.4, 1.1, 3.7]) {
          const at = (z: number): LODTransform => ({ k: z, x: big / 2 - 400 * z, y: big / 2 - 400 * z });
          const cutAt = (tree: LODTree, z: number, s: number) => cut(tree, at(z), big, big, { expandPx: 48, spacing: s, screenSized: true, maxAggregateRadius: 20 }).slice();
          const a = cutAt(one, k / spacing, 1);
          const b = cutAt(scaled, k, spacing);
          expect(ids(b), `${name}, spacing ${spacing}, k = ${k}: the cut`).toEqual(ids(a));
          const keepA = declutterFrontier(one, a, at(k / spacing), big, big, { screenSized: true, k: k / spacing, maxAggregateRadius: 20, spacing: 1 });
          const keepB = declutterFrontier(scaled, b, at(k), big, big, { screenSized: true, k, maxAggregateRadius: 20, spacing });
          expect(ids(keepB), `${name}, spacing ${spacing}, k = ${k}: the declutter`).toEqual(ids(keepA));
          if (a.length > 1) compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(10);
  });
});
