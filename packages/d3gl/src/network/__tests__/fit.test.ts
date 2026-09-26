import { describe, it, expect } from "vitest";
import { layoutBox, fitTransform, type FitBox } from "../fit.js";
import { buildModuleLODTree } from "../modules.js";
import { buildLODTree, computeLODPositions } from "../lod.js";
import { buildGraph } from "../graph.js";

/**
 * Guards fit-on-layout's framing (#206, #327). The fit frames a streaming layout by the box of its
 * **leaf positions**, so it must be:
 *   - **tight** — within a few % of the leaves' true bounding box. The box it replaces padded the
 *     top modules' centroids by their median LOD `extent`, and `extent` compounds up the tree, so
 *     it framed the layout 1.6-4.3× too loose (#327);
 *   - **robust to fling-outs** (#206) — a stray leaf flung far away must not blow the frame up
 *     and shrink the rest of the layout to a dot ("all white").
 * These tests pin both, plus the contrast that shows why no LOD `extent` box is used.
 */

const W = 800;
const H = 600;
const MODULES = 4;
const PER = 50; // leaves per module
const N = MODULES * PER;
const CORNERS: [number, number][] = [[100, 100], [900, 100], [100, 900], [900, 900]];

/** 4 tight modules at the corners of a 1000×1000 box; optionally fling one leaf far away. */
function cornerLayout(flingLeaf: number | null): Float32Array {
  const pos = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) {
    const [bx, by] = CORNERS[Math.floor(i / PER)] ?? [0, 0];
    // Deterministic small jitter so a module has real (but tight) spatial extent.
    pos[2 * i] = bx + ((i * 37) % 40) - 20;
    pos[2 * i + 1] = by + ((i * 53) % 40) - 20;
  }
  if (flingLeaf !== null) {
    pos[2 * flingLeaf] = 20000;
    pos[2 * flingLeaf + 1] = 20000;
  }
  return pos;
}

/** The exact bounding box of the leaves, optionally excluding one. */
function exactBox(pos: Float32Array, count: number, exclude: number | null = null): FitBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    if (i === exclude) continue;
    const x = pos[2 * i] ?? 0;
    const y = pos[2 * i + 1] ?? 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

const span = (b: FitBox): number => Math.max(b[2] - b[0], b[3] - b[1]);

/** Screen bbox of the leaves (optionally excluding one) after a transform; + fraction of the view filled. */
function mappedLeaves(pos: Float32Array, count: number, t: { k: number; x: number; y: number }, exclude: number | null) {
  const [minX, minY, maxX, maxY] = exactBox(pos, count, exclude);
  const s = { minX: t.k * minX + t.x, minY: t.k * minY + t.y, maxX: t.k * maxX + t.x, maxY: t.k * maxY + t.y };
  return { ...s, fill: Math.max(s.maxX - s.minX, s.maxY - s.minY) / Math.min(W, H) };
}

/** A uniform disc of `n` leaves (a golden-angle spiral — what a settled force layout looks like). */
function disc(n: number, r: number): Float32Array {
  const pos = new Float32Array(2 * n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const d = r * Math.sqrt((i + 0.5) / n);
    pos[2 * i] = 500 + d * Math.cos(i * golden);
    pos[2 * i + 1] = -300 + d * Math.sin(i * golden);
  }
  return pos;
}

/** Largest per-side deviation of `box` from `ref`, as a fraction of `ref`'s span. */
function sideError(box: FitBox, ref: FitBox): number {
  const s = span(ref);
  return Math.max(...box.map((v, i) => Math.abs(v - (ref[i] ?? 0)) / s));
}

describe("layoutBox is tight", () => {
  it("equals the exact bounding box of a clean layout (no stragglers)", () => {
    for (const n of [50, 1000, 20_000]) {
      const pos = disc(n, 400);
      const box = layoutBox(pos, n);
      expect(box).not.toBeNull();
      if (!box) continue;
      expect(sideError(box, exactBox(pos, n)), `n=${n}`).toBeLessThan(1e-6);
    }
  });

  it("follows the layout it is given frame by frame (a growing layout grows the box)", () => {
    const n = 5000;
    let prev = 0;
    for (const r of [100, 400, 1600, 6400]) {
      const box = layoutBox(disc(n, r), n);
      if (!box) throw new Error("no box");
      expect(span(box) / (2 * r)).toBeGreaterThan(0.99);
      expect(span(box) / (2 * r)).toBeLessThan(1.01);
      expect(span(box)).toBeGreaterThan(prev);
      prev = span(box);
    }
  });

  it("keeps a displaced group that is part of the layout (more than a handful of leaves)", () => {
    const n = 20_000;
    const pos = disc(n, 400);
    for (let i = 0; i < 1000; i++) pos[2 * i] = (pos[2 * i] ?? 0) + 5000; // 5% of the layout, far to the right
    const box = layoutBox(pos, n);
    if (!box) throw new Error("no box");
    expect(sideError(box, exactBox(pos, n))).toBeLessThan(0.01);
  });

  it("ignores non-finite positions and returns null when none are finite", () => {
    const pos = disc(1000, 400);
    const ref = exactBox(pos, 1000);
    pos[0] = NaN;
    pos[3] = Infinity;
    const box = layoutBox(pos, 1000);
    if (!box) throw new Error("no box");
    expect(sideError(box, ref)).toBeLessThan(0.01);
    expect(layoutBox(new Float32Array([NaN, NaN, NaN, NaN]), 2)).toBeNull();
    expect(layoutBox(new Float32Array(0), 0)).toBeNull();
  });

  it("frames a degenerate (single-point) layout without dividing by zero", () => {
    expect(layoutBox(new Float32Array([7, 9, 7, 9, 7, 9]), 3)).toEqual([7, 9, 7, 9]);
    const many = new Float32Array(2 * 1000).fill(3);
    expect(layoutBox(many, 1000)).toEqual([3, 3, 3, 3]);
  });
});

describe("layoutBox is robust to fling-outs (the 'all white' bug)", () => {
  const flung = layoutBox(cornerLayout(2), N);
  const clean = layoutBox(cornerLayout(null), N);

  it("a flung-out leaf does not change the frame (the bulk's exact box)", () => {
    if (!flung || !clean) throw new Error("no box");
    // A single leaf at (20000,20000) — 20× outside the cluster — must not blow the frame up.
    expect(sideError(flung, exactBox(cornerLayout(2), N, 2))).toBeLessThan(0.01);
    expect(span(flung)).toBeLessThan(span(clean) * 1.05);
  });

  it("frames the bulk into the viewport at the fit's fill, even WITH the fling-out present", () => {
    if (!flung) throw new Error("no box");
    const pos = cornerLayout(2);
    const t = fitTransform(flung, W, H);
    const m = mappedLeaves(pos, N, t, 2); // the 199 non-flung leaves
    expect(m.minX).toBeGreaterThan(-1);
    expect(m.minY).toBeGreaterThan(-1);
    expect(m.maxX).toBeLessThan(W + 1);
    expect(m.maxY).toBeLessThan(H + 1);
    expect(m.fill).toBeGreaterThan(0.8); // NOT collapsed to a dot — the bulk fills the frame
  });

  it("drops a handful of stragglers at any size (40 leaves flung out of 20k)", () => {
    const n = 20_000;
    const pos = disc(n, 400);
    const bulk = exactBox(pos, n);
    for (let i = 0; i < 40; i++) {
      pos[2 * i] = 20_000 + i;
      pos[2 * i + 1] = -20_000 - i;
    }
    const box = layoutBox(pos, n);
    if (!box) throw new Error("no box");
    expect(sideError(box, bulk)).toBeLessThan(0.02);
  });

  it("never jumps: the frame follows a straggler drifting back in continuously", () => {
    const pos = cornerLayout(null);
    const bulk = exactBox(pos, N);
    const size = span(bulk);
    const step = 0.01 * size;
    let prev: FitBox | null = null;
    for (let x = bulk[2] + 2 * size; x >= bulk[2]; x -= step) {
      pos[4] = x; // leaf 2 drifts in along +x, from two layout sizes out to the bulk's edge
      const box = layoutBox(pos, N);
      if (!box) throw new Error("no box");
      if (prev) expect(Math.abs(box[2] - prev[2])).toBeLessThan(2 * step);
      prev = box;
    }
  });

  it("the naive root cx±extent box WOULD collapse the layout (documents why extent is not used)", () => {
    const pos = cornerLayout(2);
    const paths = Array.from({ length: N }, (_, i) => ({ id: i, path: [Math.floor(i / PER) + 1, (i % PER) + 1] }));
    const tree = buildModuleLODTree(N, paths);
    computeLODPositions(tree, pos);
    const root = tree.parent ? tree.parent.findIndex((p) => p < 0) : tree.size - 1;
    const cx = tree.cx[root] ?? 0;
    const cy = tree.cy[root] ?? 0;
    const r = tree.extent[root] ?? 0;
    const m = mappedLeaves(pos, N, fitTransform([cx - r, cy - r, cx + r, cy + r], W, H), 2);
    expect(m.fill).toBeLessThan(0.1); // the bulk shrinks to a speck — this is the "all white" the fix removes
  });
});

describe("layoutBox vs the LOD extent (#327): the leaf box is tight whatever the LOD tree", () => {
  it("a coarsening tree's top aggregates bound the layout far more loosely than its leaves do", () => {
    // A ring lattice: coarsening pairs neighbours level after level, so each aggregate's `extent`
    // (farthest child distance + that child's extent) compounds up the tree.
    const n = 4096;
    const source: number[] = [];
    const target: number[] = [];
    for (let i = 0; i < n; i++) {
      source.push(i, i);
      target.push((i + 1) % n, (i + 7) % n);
    }
    const graph = buildGraph({ nodeCount: n, source, target });
    const pos = disc(n, 1000);
    graph.positions.set(pos);
    const tree = buildLODTree(graph, {});
    computeLODPositions(tree, pos);
    const truth = exactBox(pos, n);
    const box = layoutBox(pos, n);
    if (!box) throw new Error("no box");
    expect(sideError(box, truth)).toBeLessThan(0.01); // tight, LOD on or off: it reads the leaves

    // The top level's extents bound the layout, but loosely — which is why the fit does not use them.
    const top = tree.levelOffset[tree.levelCount - 1] ?? 0;
    let loose = 0;
    for (let g = top; g < tree.size; g++) loose = Math.max(loose, 2 * (tree.extent[g] ?? 0));
    expect(loose).toBeGreaterThan(1.3 * span(truth));
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

  it("keeps a screen-space pad around the box (screen-sized glyphs stay inside the frame)", () => {
    const t = fitTransform([0, 0, 400, 100], W, H, { padPx: 10 });
    expect(t.k * 400 + 2 * 10).toBeCloseTo(0.85 * Math.min(W, H), 6);
    expect(t.k * 200 + t.x).toBeCloseTo(W / 2, 6); // still centred
  });

  it("does not let an oversized pad flip or zero the scale", () => {
    const t = fitTransform([0, 0, 400, 100], W, H, { padPx: 10_000 });
    expect(t.k).toBeGreaterThan(0);
    expect(Number.isFinite(t.k)).toBe(true);
  });

  it("does not divide by zero for a degenerate (single-point) box", () => {
    const t = fitTransform([50, 50, 50, 50], W, H);
    expect(Number.isFinite(t.k)).toBe(true);
    expect(t.k * 50 + t.x).toBeCloseTo(W / 2, 6);
  });
});
