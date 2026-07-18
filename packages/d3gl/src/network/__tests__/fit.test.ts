import { describe, it, expect } from "vitest";
import { fitNodes, fitBox, fitTransform, type FitBox } from "../fit.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODPositions } from "../lod.js";

/**
 * Guards fit-on-layout's framing (#206). The library-shipped bug this replaces: framing to the tree
 * root's `cx ± extent` (a MAX bounding radius) — a single force-layout **fling-out** node inflated the
 * root's extent, blowing the frame up so the whole layout collapsed to a dot ("all white"). These tests
 * assert the fit is **robust to fling-outs** (the exact failure), frames the bulk into the viewport, and
 * that the old extent-based box would NOT — so the regression can't return unnoticed.
 */

const W = 800;
const H = 600;
const MODULES = 4;
const PER = 50; // leaves per module — enough that one fling-out barely moves a module centroid
const N = MODULES * PER;
const CORNERS: [number, number][] = [[100, 100], [900, 100], [100, 900], [900, 900]];

/** 4 tight modules at the corners of a 1000×1000 box; optionally fling one leaf far away. */
function makeTree(flingLeaf: number | null) {
  const paths = Array.from({ length: N }, (_, i) => ({ id: i, path: [Math.floor(i / PER) + 1, (i % PER) + 1] }));
  const tree = buildModuleLODTree(N, paths);
  const pos = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) {
    const [bx, by] = CORNERS[Math.floor(i / PER)]!;
    // Deterministic small jitter so a module has real (but tight) spatial extent.
    pos[2 * i] = bx + ((i * 37) % 40) - 20;
    pos[2 * i + 1] = by + ((i * 53) % 40) - 20;
  }
  if (flingLeaf !== null) {
    pos[2 * flingLeaf] = 20000;
    pos[2 * flingLeaf + 1] = 20000;
  }
  computeLODPositions(tree, pos);
  return { tree, pos };
}

/** Screen bbox of the leaves (optionally excluding one) after a transform; + fraction of the view filled. */
function mappedLeaves(pos: Float32Array, t: { k: number; x: number; y: number }, exclude: number | null) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    if (i === exclude) continue;
    const sx = t.k * pos[2 * i]! + t.x;
    const sy = t.k * pos[2 * i + 1]! + t.y;
    minX = Math.min(minX, sx); minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx); maxY = Math.max(maxY, sy);
  }
  return { minX, minY, maxX, maxY, fill: Math.max(maxX - minX, maxY - minY) / Math.min(W, H) };
}

describe("fitNodes", () => {
  it("returns the top modules (children of the synthetic root), not the leaves or the root", () => {
    const { tree } = makeTree(null);
    const nodes = fitNodes(tree);
    expect(nodes.length).toBe(MODULES); // the 4 modules, not 200 leaves and not the 1 root
    for (const g of nodes) expect(g).toBeGreaterThanOrEqual(tree.leafCount); // aggregates, never leaves
  });
});

describe("fitBox is robust to fling-outs (the 'all white' bug)", () => {
  const flung = fitBox(makeTree(2).tree, fitNodes(makeTree(2).tree), new Float32Array(N))!;
  const clean = fitBox(makeTree(null).tree, fitNodes(makeTree(null).tree), new Float32Array(N))!;
  const span = (b: FitBox) => Math.max(b[2] - b[0], b[3] - b[1]);

  it("a flung-out node barely changes the frame (span within 1.5× of the clean frame)", () => {
    // A single leaf at (20000,20000) — 20× outside the cluster — must not blow the frame up.
    expect(span(flung)).toBeLessThan(span(clean) * 1.5);
  });

  it("frames the bulk into the viewport at a healthy fill, even WITH the fling-out present", () => {
    const { pos } = makeTree(2);
    const t = fitTransform(flung, W, H);
    const m = mappedLeaves(pos, t, 2); // the 199 non-flung leaves
    expect(m.minX).toBeGreaterThan(-1);
    expect(m.minY).toBeGreaterThan(-1);
    expect(m.maxX).toBeLessThan(W + 1);
    expect(m.maxY).toBeLessThan(H + 1);
    expect(m.fill).toBeGreaterThan(0.3); // NOT collapsed to a dot
  });

  it("the naive root cx±extent box WOULD collapse the layout (documents why extent is not used)", () => {
    const { tree, pos } = makeTree(2);
    // Root is the single node whose parent is -1 (or the coarsest level's node).
    const root = tree.parent ? tree.parent.findIndex((p) => p < 0) : tree.size - 1;
    const naive: FitBox = [tree.cx[root]! - tree.extent[root]!, tree.cy[root]! - tree.extent[root]!, tree.cx[root]! + tree.extent[root]!, tree.cy[root]! + tree.extent[root]!];
    const t = fitTransform(naive, W, H);
    const m = mappedLeaves(pos, t, 2);
    expect(m.fill).toBeLessThan(0.1); // the bulk shrinks to a speck — this is the "all white" the fix removes
  });
});

describe("fitTransform", () => {
  it("centres the box centre in the viewport", () => {
    const box: FitBox = [100, 200, 300, 500];
    const t = fitTransform(box, W, H);
    expect(t.k * 200 + t.x).toBeCloseTo(W / 2, 6);
    expect(t.k * 350 + t.y).toBeCloseTo(H / 2, 6);
  });

  it("scales the longest side to 0.85 of the shorter viewport dimension", () => {
    const t = fitTransform([0, 0, 400, 100], W, H);
    expect(t.k * 400).toBeCloseTo(0.85 * Math.min(W, H), 6);
  });

  it("does not divide by zero for a degenerate (single-point) box", () => {
    const t = fitTransform([50, 50, 50, 50], W, H);
    expect(Number.isFinite(t.k)).toBe(true);
    expect(t.k * 50 + t.x).toBeCloseTo(W / 2, 6);
  });
});
