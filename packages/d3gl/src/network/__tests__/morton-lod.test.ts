import { describe, it, expect } from "vitest";
import { hcl, rgb } from "d3-color";
import {
  buildMortonLODTree,
  buildMortonTopology,
  buildLODTree,
  computeLODPositions,
  computeLODStyle,
  cut,
  findMortonCell,
  makeCutScratch,
  makeMortonScratch,
  mortonRootBox,
  type LODTree,
  type MortonBox,
} from "../lod.js";
import { buildGraph } from "../graph.js";

/** Deterministic LCG in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** `n` points in a few Gaussian-ish clusters plus uniform noise — uneven density, like a force layout. */
function clusteredCloud(n: number, seed = 7): Float32Array {
  const r = rng(seed);
  const pos = new Float32Array(n * 2);
  const centres = [[100, 120], [700, 300], [400, 800], [-300, 50]];
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) {
      pos[2 * i] = -400 + r() * 1300;
      pos[2 * i + 1] = -100 + r() * 1100;
    } else {
      const c = centres[i % centres.length]!;
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(-2 * Math.log(r() + 1e-12)) * 40;
      pos[2 * i] = c[0]! + Math.cos(a) * d;
      pos[2 * i + 1] = c[1]! + Math.sin(a) * d;
    }
  }
  return pos;
}

/** The Morton cell of a point in `box` at `level`, as (level, left-aligned prefix). */
function pointCode(box: MortonBox, x: number, y: number): number {
  const s = 65536 / box.side;
  const qx = Math.min(65535, Math.max(0, Math.floor((x - box.x0) * s)));
  const qy = Math.min(65535, Math.max(0, Math.floor((y - box.y0) * s)));
  let code = 0;
  for (let b = 15; b >= 0; b--) code = code * 4 + (((qy >> b) & 1) << 1) + ((qx >> b) & 1);
  return code >>> 0;
}
const prefixAt = (code: number, level: number): number => (level === 0 ? 0 : Math.floor(code / 2 ** (32 - 2 * level)));

/** Every structural invariant of a Morton tree (#343). */
function checkMortonTree(tree: LODTree, pos: Float32Array, bucket: number): void {
  const { size, leafCount: n, levelCount, levelOffset, childOffset, children } = tree;
  const parent = tree.parent!;
  const { leafOrder, leafStart, leafEnd, morton } = tree;
  expect(leafOrder && leafStart && leafEnd && morton).toBeTruthy();
  if (!leafOrder || !leafStart || !leafEnd || !morton) return;
  expect(levelOffset[0]).toBe(0);
  expect(levelOffset[1]).toBe(n);
  expect(levelOffset[levelCount]).toBe(size);
  expect(levelOffset[levelCount]! - levelOffset[levelCount - 1]!).toBe(1); // one root
  // leafOrder is a permutation, and a leaf's run is its rank
  const seen = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    const leaf = leafOrder[r]!;
    expect(seen[leaf]).toBe(0);
    seen[leaf] = 1;
    expect(leafStart[leaf]).toBe(r);
    expect(leafEnd[leaf]).toBe(r + 1);
  }
  const levelOf = (g: number): number => {
    let k = 0;
    while (levelOffset[k + 1]! <= g) k++;
    return k;
  };
  for (let g = n; g < size; g++) {
    const c0 = childOffset[g]!;
    const c1 = childOffset[g + 1]!;
    expect(c1 - c0).toBeGreaterThanOrEqual(1);
    // children partition the node's run, in order, and sit on lower levels
    let at = leafStart[g]!;
    let leafKids = 0;
    for (let p = c0; p < c1; p++) {
      const c = children[p]!;
      expect(parent[c]).toBe(g);
      expect(levelOf(c)).toBeLessThan(levelOf(g));
      expect(leafStart[c]).toBe(at);
      at = leafEnd[c]!;
      if (c < n) leafKids++;
    }
    expect(at).toBe(leafEnd[g]);
    // a node's children are all leaves (a bottom cell) or all cells
    expect(leafKids === 0 || leafKids === c1 - c0).toBe(true);
    const o = g - n;
    const level = morton.level[o]!;
    const code = morton.code[o]!;
    if (leafKids > 0) {
      // bottom cell: ≤ bucket leaves unless they are all coincident at full resolution
      if (c1 - c0 > bucket) expect(level).toBe(16);
    } else {
      expect(c1 - c0).toBeGreaterThanOrEqual(2); // compressed: no single-child chains
    }
    // every leaf in the run quantises into the cell, and the cell is the longest shared prefix
    for (let r = leafStart[g]!; r < leafEnd[g]!; r++) {
      const leaf = leafOrder[r]!;
      expect(prefixAt(pointCode(morton.box, pos[2 * leaf]!, pos[2 * leaf + 1]!), level)).toBe(prefixAt(code, level));
    }
  }
  for (let i = 0; i < n; i++) expect(parent[i]).toBeGreaterThanOrEqual(n); // every leaf has a bottom cell
}

describe("buildMortonLODTree (#343)", () => {
  it("builds a compressed, bucketed quadtree whose every node covers one contiguous leaf run", () => {
    const n = 4000;
    const pos = clusteredCloud(n);
    const tree = buildMortonLODTree(pos, n);
    checkMortonTree(tree, pos, 8);
    expect(tree.leafBranching).toBeGreaterThan(1); // bottom cells hold several leaves
    expect(tree.size).toBeLessThan(n * 1.6);
  });

  it("honours the bucket and the depth cap, and buckets coincident points into one cell", () => {
    const n = 1500;
    const pos = clusteredCloud(n, 11);
    for (const bucket of [1, 4, 32]) checkMortonTree(buildMortonLODTree(pos, n, { bucket }), pos, bucket);
    const shallow = buildMortonLODTree(pos, n, { maxDepth: 3 });
    for (let g = shallow.leafCount; g < shallow.size; g++) {
      const o = g - shallow.leafCount;
      const kids = shallow.childOffset[g + 1]! - shallow.childOffset[g]!;
      const isBottom = shallow.children[shallow.childOffset[g]!]! < shallow.leafCount;
      if (!isBottom) expect(shallow.morton!.level[o]).toBeLessThan(3);
      expect(kids).toBeGreaterThan(0);
    }
    const coincident = new Float32Array(2 * 100).fill(3);
    const tree = buildMortonLODTree(coincident, 100);
    expect(tree.size).toBe(101); // one bottom cell holding all 100
    expect(tree.childOffset[101]! - tree.childOffset[100]!).toBe(100);
  });

  it("handles tiny inputs: nothing, one leaf, a handful under one bottom cell", () => {
    expect(buildMortonLODTree(new Float32Array(0), 0).size).toBe(0);
    const one = buildMortonLODTree(Float32Array.from([5, 5]), 1);
    expect(one.size).toBe(1);
    expect(one.levelCount).toBe(1);
    const four = buildMortonLODTree(Float32Array.from([0, 0, 10, 0, 0, 10, 10, 10]), 4);
    expect(four.size).toBe(5);
    expect(four.levelCount).toBe(2);
    checkMortonTree(four, Float32Array.from([0, 0, 10, 0, 0, 10, 10, 10]), 8);
  });

  it("reuses a scratch across rebuilds with identical output", () => {
    const n = 3000;
    const pos = clusteredCloud(n, 5);
    const sc = makeMortonScratch();
    const box = mortonRootBox(pos, n);
    const a = buildMortonTopology(pos, n, { box }, sc);
    const b = buildMortonTopology(clusteredCloud(n, 6), n, { box: mortonRootBox(clusteredCloud(n, 6), n) }, sc);
    expect(b.size).toBeGreaterThan(n);
    const c = buildMortonTopology(pos, n, { box }, sc);
    expect(Array.from(c.children)).toEqual(Array.from(a.children));
    expect(Array.from(c.leafOrder)).toEqual(Array.from(a.leafOrder));
    expect(Array.from(c.morton.code)).toEqual(Array.from(a.morton.code));
  });
});

describe("mortonRootBox (#343)", () => {
  it("is a power-of-two square on a quarter-side grid that holds every point", () => {
    const n = 2000;
    const pos = clusteredCloud(n);
    const box = mortonRootBox(pos, n);
    expect(Number.isInteger(Math.log2(box.side))).toBe(true);
    expect(Number.isInteger(box.x0 / (box.side / 4))).toBe(true);
    expect(Number.isInteger(box.y0 / (box.side / 4))).toBe(true);
    for (let i = 0; i < n; i++) {
      expect(pos[2 * i]!).toBeGreaterThanOrEqual(box.x0);
      expect(pos[2 * i]!).toBeLessThan(box.x0 + box.side);
      expect(pos[2 * i + 1]!).toBeGreaterThanOrEqual(box.y0);
      expect(pos[2 * i + 1]!).toBeLessThan(box.y0 + box.side);
    }
  });

  it("keeps the previous box while the layout fits it, and moves on when a point leaves it", () => {
    const n = 1000;
    const pos = clusteredCloud(n);
    const box = mortonRootBox(pos, n);
    const jittered = pos.map((v, i) => v + (i % 3) - 1);
    expect(mortonRootBox(jittered, n, box)).toBe(box); // same object: cells unchanged
    const escaped = pos.slice();
    escaped[0] = box.x0 + box.side * 3;
    const moved = mortonRootBox(escaped, n, box);
    expect(moved).not.toBe(box);
    expect(escaped[0]!).toBeLessThan(moved.x0 + moved.side);
    // a layout that shrank to a small corner of the box gets a fresh, tighter box
    const shrunk = pos.map((v) => v / 64);
    expect(mortonRootBox(shrunk, n, box).side).toBeLessThan(box.side);
  });
});

describe("findMortonCell (#343)", () => {
  it("finds every aggregate of a tree again by its own cell", () => {
    const n = 3000;
    const pos = clusteredCloud(n, 9);
    const tree = buildMortonLODTree(pos, n);
    const { box, level, code } = tree.morton!;
    for (let g = n; g < tree.size; g++) expect(findMortonCell(tree, box, level[g - n]!, code[g - n]!)).toBe(g);
  });

  it("maps an aggregate onto the node for the same square after a rebuild in the same box", () => {
    const n = 3000;
    const pos = clusteredCloud(n, 9);
    const a = buildMortonLODTree(pos, n);
    const box = a.morton!.box;
    const r = rng(1);
    const moved = pos.map((v) => v + (r() - 0.5) * 2);
    const b = buildMortonLODTree(moved, n, { box: mortonRootBox(moved, n, box) });
    expect(b.morton!.box).toBe(box);
    let exact = 0;
    for (let g = n; g < a.size; g++) {
      const lv = a.morton!.level[g - n]!;
      const cd = a.morton!.code[g - n]!;
      const h = findMortonCell(b, box, lv, cd);
      if (h < 0) continue; // the square emptied
      const hl = b.morton!.level[h - n]!;
      const hc = b.morton!.code[h - n]!;
      // inside the square (as deep or deeper, same prefix) or a bottom cell covering it
      const lvMin = Math.min(lv, hl);
      expect(prefixAt(hc, lvMin)).toBe(prefixAt(cd, lvMin));
      if (hl === lv && hc === cd) exact++;
    }
    expect(exact).toBeGreaterThan((a.size - n) * 0.5);
  });

  it("re-expresses a cell of another box on the shared power-of-two grid", () => {
    const n = 2000;
    const pos = clusteredCloud(n, 4);
    const a = buildMortonLODTree(pos, n);
    const box = a.morton!.box;
    const bigger: MortonBox = { x0: box.x0 - box.side, y0: box.y0 - box.side, side: box.side * 4 };
    const b = buildMortonLODTree(pos, n, { box: bigger });
    let found = 0;
    for (let g = n; g < a.size; g++) {
      const lv = a.morton!.level[g - n]!;
      if (lv < 2 || lv > 14) continue;
      const h = findMortonCell(b, box, lv, a.morton!.code[g - n]!);
      expect(h).toBeGreaterThanOrEqual(n);
      // the same leaves (the cell is the same square, so the same members)
      if (b.leafEnd![h]! - b.leafStart![h]! === a.leafEnd![g]! - a.leafStart![g]!) found++;
    }
    expect(found).toBeGreaterThan(0);
  });
});

/** The farthest descendant leaf of every node from its centroid (brute force). */
function trueRadius(tree: LODTree): Float64Array {
  const r = new Float64Array(tree.size);
  const parent = tree.parent!;
  for (let i = 0; i < tree.leafCount; i++) {
    for (let a = parent[i]!; a >= 0; a = parent[a]!) {
      const d = Math.hypot(tree.cx[i]! - tree.cx[a]!, tree.cy[i]! - tree.cy[a]!);
      if (d > r[a]!) r[a] = d;
    }
  }
  return r;
}

describe("computeLODPositions tight extents (#343)", () => {
  it("bounds every leaf and stays within 1.5× the true radius at every level of a Morton tree", () => {
    const n = 4000;
    const pos = clusteredCloud(n, 2);
    const tree = buildMortonLODTree(pos, n);
    computeLODPositions(tree, pos);
    const r = trueRadius(tree);
    let worst = 0;
    for (let g = n; g < tree.size; g++) {
      expect(tree.extent[g]! * (1 + 1e-6) + 1e-4).toBeGreaterThanOrEqual(r[g]!);
      if (r[g]! > 0) worst = Math.max(worst, tree.extent[g]! / r[g]!);
    }
    expect(worst).toBeLessThan(1.5);
  });

  it("tightens a coarsening tree's compounding extents without ever under-bounding a leaf", () => {
    const n = 3000;
    const r0 = rng(3);
    const src: number[] = [];
    const tgt: number[] = [];
    for (let i = 1; i < n; i++) {
      src.push(i);
      tgt.push(Math.floor(r0() * i));
      if (i % 3 === 0) { src.push(i); tgt.push(Math.floor(r0() * n)); }
    }
    const g = buildGraph({ nodeCount: n, source: src, target: tgt });
    g.positions.set(clusteredCloud(n, 8));
    const tree = buildLODTree(g);
    computeLODPositions(tree, g.positions);
    const r = trueRadius(tree);
    // the old compounding-only extent, recomputed here for comparison
    const comp = new Float64Array(tree.size);
    for (let k = 1; k < tree.levelCount; k++) {
      for (let a = tree.levelOffset[k]!; a < tree.levelOffset[k + 1]!; a++) {
        for (let p = tree.childOffset[a]!; p < tree.childOffset[a + 1]!; p++) {
          const c = tree.children[p]!;
          comp[a] = Math.max(comp[a]!, Math.hypot(tree.cx[a]! - tree.cx[c]!, tree.cy[a]! - tree.cy[c]!) + comp[c]!);
        }
      }
    }
    let tighter = 0;
    for (let a = n; a < tree.size; a++) {
      expect(tree.extent[a]! * (1 + 1e-6) + 1e-4).toBeGreaterThanOrEqual(r[a]!);
      expect(tree.extent[a]!).toBeLessThanOrEqual(comp[a]! * (1 + 1e-6) + 1e-4);
      if (tree.extent[a]! < comp[a]! * 0.99) tighter++;
    }
    expect(tighter).toBeGreaterThan(0);
  });
});

describe("computeLODStyle colours (#343: inline HCL, bit-identical to d3-color)", () => {
  for (const palette of [false, true]) it(`aggregates colours exactly as hcl(rgb(...)) / rgb(hcl(...)) did (${palette ? "an 8-colour palette: memo hits" : "random colours"})`, () => {
    const n = 2000;
    const pos = clusteredCloud(n, 12);
    const tree = buildMortonLODTree(pos, n);
    const r = rng(21);
    const colors = new Uint8Array(4 * n);
    for (let i = 0; i < 4 * n; i++) colors[i] = Math.floor(r() * 256);
    for (let i = 0; i < n; i += 7) colors[4 * i] = colors[4 * i + 1] = colors[4 * i + 2] = i % 256; // greys
    if (palette) for (let i = 0; i < 4 * n; i++) colors[i] = colors[(i % 4) + 4 * ((i >> 2) % 8)]!;
    computeLODStyle(tree, new Float32Array(n).fill(1), new Float32Array(n).fill(1), undefined, colors);
    // Reference: the d3-color pass the inline conversion replaced.
    const ref = new Uint8Array(4 * tree.size);
    ref.set(colors);
    for (let k = 1; k < tree.levelCount; k++) {
      for (let g = tree.levelOffset[k]!; g < tree.levelOffset[k + 1]!; g++) {
        let hx = 0, hy = 0, sumC = 0, sumL = 0, sumA = 0, nc = 0;
        for (let p = tree.childOffset[g]!; p < tree.childOffset[g + 1]!; p++) {
          const c = tree.children[p]!;
          const col = hcl(rgb(ref[c * 4]!, ref[c * 4 + 1]!, ref[c * 4 + 2]!));
          const ch = Number.isNaN(col.c) ? 0 : col.c;
          if (!Number.isNaN(col.h)) {
            hx += Math.cos((col.h * Math.PI) / 180) * ch;
            hy += Math.sin((col.h * Math.PI) / 180) * ch;
          }
          sumC += ch;
          sumL += Number.isNaN(col.l) ? 0 : col.l;
          sumA += ref[c * 4 + 3]!;
          nc++;
        }
        const out = rgb(hcl((Math.atan2(hy, hx) * 180) / Math.PI, sumC / nc, sumL / nc));
        ref[g * 4] = Math.max(0, Math.min(255, Math.round(out.r)));
        ref[g * 4 + 1] = Math.max(0, Math.min(255, Math.round(out.g)));
        ref[g * 4 + 2] = Math.max(0, Math.min(255, Math.round(out.b)));
        ref[g * 4 + 3] = Math.round(sumA / nc);
      }
    }
    expect(Array.from(tree.color)).toEqual(Array.from(ref));
  });
});

describe("cut recordCulled (#343)", () => {
  it("records culled roots so the frontier and the culled roots cover every leaf exactly once", () => {
    const n = 5000;
    const pos = clusteredCloud(n, 3);
    const tree = buildMortonLODTree(pos, n);
    computeLODPositions(tree, pos);
    computeLODStyle(tree, new Float32Array(n).fill(3), new Float32Array(n).fill(1));
    const sc = makeCutScratch();
    for (const k of [0.6, 2, 8]) {
      const t = { k, x: 300 - 200 * k, y: 300 - 300 * k };
      const frontier = cut(tree, t, 600, 600, { screenSized: true, recordCulled: true }, sc).slice();
      const covered = new Uint8Array(n);
      const mark = (g: number): void => {
        for (let r = tree.leafStart![g]!; r < tree.leafEnd![g]!; r++) covered[tree.leafOrder![r]!]!++;
      };
      for (const g of frontier) mark(g);
      for (let i = 0; i < sc.culledCount; i++) mark(sc.culled[i]!);
      expect(covered.every((c) => c === 1)).toBe(true);
      expect(sc.splitCount).toBe(0);
      // and the frontier alone is unchanged by the option
      expect(Array.from(cut(tree, t, 600, 600, { screenSized: true }))).toEqual(Array.from(frontier));
    }
  });

  it("records the nodes a cross-fade band both draws and expands", () => {
    const n = 5000;
    const pos = clusteredCloud(n, 3);
    const tree = buildMortonLODTree(pos, n);
    computeLODPositions(tree, pos);
    computeLODStyle(tree, new Float32Array(n).fill(3), new Float32Array(n).fill(1));
    const sc = makeCutScratch();
    const frontier = cut(tree, { k: 1.5, x: 0, y: 0 }, 900, 900, { screenSized: true, fadeBand: 0.4, fadeAlpha: new Float32Array(tree.size), recordCulled: true }, sc).slice();
    expect(sc.splitCount).toBeGreaterThan(0);
    const inFrontier = new Set(frontier);
    for (let i = 0; i < sc.splitCount; i++) {
      const g = sc.split[i]!;
      expect(inFrontier.has(g)).toBe(true);
    }
  });
});
