import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import { computeLODPositions, cut, makeCutBoundaries, visibleWorldRect, type BoundaryDiscs, type CutBoundaries, type LODTransform, type LODTree } from "../lod.js";
import { boundaryRings, superEdges, type SuperEdgeStyleResolved } from "../glyphs.js";
import { nestedLayout, nestedBoundaryDiscs } from "../nested-layout.js";

/**
 * Module boundaries (#329): the cut collects every expanded module whose boundary meets the view (the
 * rings), and — with cross-level edges on — a module link whose endpoint is such a module is drawn to or
 * from that module's boundary instead of vanishing (an `.ftree` has no finer link to project).
 *
 * The anchoring is checked exhaustively like #325's super-edge property: every cut (and a decluttered
 * subset of each) of ragged `.ftree`-shaped fixtures, everything on screen. The oracle climbs `parent`
 * from each link's endpoints, independent of the CSR and of the module-link rows.
 */

const W = 800;
const H = 600;
const ALL = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 }; // everything on screen
const STYLE: SuperEdgeStyleResolved = {
  linkStyle: "line",
  directed: true,
  widthOf: () => 1,
  colorOf: () => [0, 0, 0, 255],
  bend: 0,
  arrowSize: 3,
  crossLevelEdges: true,
};

/** Deterministic PRNG so a failing fixture is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

interface Fixture {
  label: string;
  records: ModuleNode[];
  edges: { source: number[]; target: number[]; weight: number[] };
  links: ModuleLink[];
}

/**
 * A ragged, `.ftree`-shaped fixture: modules split into 2-3 children down to `maxDepth`; graph edges only
 * between leaves of one bottom module; module links between siblings at every level (as an `.ftree`'s
 * `*Links` sections), plus cross-depth and cousin links, module ↔ leaf links, and links into an
 * endpoint's own ancestor (which lie inside one subtree and must never draw). Integer flows, so sums are
 * exact. Scanned from `seed` until it has between 30 and 5000 cuts.
 */
function ftreeFixture(seed: number, maxLeaves: number, maxDepth: number): Fixture {
  for (let s = seed; ; s += 1000) {
    const r = rng(s);
    const leafPaths: number[][] = [];
    const modulePaths: number[][] = [];
    const siblings: number[][][] = []; // per module (and the root): its children's paths
    const grow = (prefix: number[], depth: number): number => {
      const k = 2 + Math.floor(r() * 2);
      const kids: number[][] = [];
      let product = 1;
      for (let i = 1; i <= k; i++) {
        const path = [...prefix, i];
        kids.push(path);
        if (depth < maxDepth && leafPaths.length + k - i < maxLeaves && r() < 0.65) {
          modulePaths.push(path);
          product *= grow(path, depth + 1);
        } else {
          leafPaths.push(path);
        }
      }
      siblings.push(kids);
      return 1 + product;
    };
    const cuts = grow([], 1);
    if (cuts < 30 || cuts > 5000 || modulePaths.length < 3) continue;
    const records = leafPaths.map((path, id) => ({ id, path }));
    const key = (p: number[]): string => p.join(":");
    const leafId = new Map(leafPaths.map((p, id) => [key(p), id]));
    const edges = { source: [] as number[], target: [] as number[], weight: [] as number[] };
    const links: ModuleLink[] = [];
    for (const kids of siblings) {
      const leaves = kids.filter((p) => leafId.has(key(p)));
      // Leaf ↔ leaf inside one module: a graph edge (the only leaf links an .ftree stores).
      for (const a of leaves) for (const b of leaves) if (a !== b && r() < 0.5) {
        edges.source.push(leafId.get(key(a))!);
        edges.target.push(leafId.get(key(b))!);
        edges.weight.push(1 + Math.floor(r() * 4));
      }
      // Every other sibling pair (module ↔ module, module ↔ leaf): a module link.
      for (const a of kids) for (const b of kids) {
        if (a === b || (leafId.has(key(a)) && leafId.has(key(b))) || r() < 0.3) continue;
        links.push({ source: a, target: b, flow: 1 + Math.floor(r() * 9) });
      }
    }
    // Beyond .ftree: cross-depth / cousin links and links into an endpoint's own ancestor.
    const nodes = [...leafPaths, ...modulePaths];
    for (let l = 0; l < 6; l++) {
      const a = nodes[Math.floor(r() * nodes.length)]!;
      const b = nodes[Math.floor(r() * nodes.length)]!;
      if (key(a) !== key(b)) links.push({ source: a, target: b, flow: 16 + Math.floor(r() * 16) });
    }
    const m = modulePaths[Math.floor(r() * modulePaths.length)]!;
    links.push({ source: [...m, 1], target: m, flow: 1000 }); // child → its own parent: never drawn
    return { label: `ftree-shaped (seed ${s}, ${leafPaths.length} leaves, ${modulePaths.length} modules, ${cuts} cuts)`, records, edges, links };
  }
}

/** Path string → tree id, spelled from `parent` + `branch`. */
function idsByPath(tree: LODTree): Map<string, number> {
  const parent = tree.parent!;
  const branch = tree.branch!;
  const out = new Map<string, number>();
  for (let g = 0; g < tree.size; g++) {
    const path: number[] = [];
    for (let x = g; parent[x]! >= 0; x = parent[x]!) path.unshift(branch[x]!);
    out.set(path.join(":"), g);
  }
  return out;
}

/** Every cut of the subtree at `g`: `[g]` itself, or (an aggregate) one cut per child, combined. */
function cutsOf(tree: LODTree, g: number): number[][] {
  const out: number[][] = [[g]];
  if (g < tree.leafCount) return out;
  let combos: number[][] = [[]];
  for (let c = tree.childOffset[g]!; c < tree.childOffset[g + 1]!; c++) {
    const sub = cutsOf(tree, tree.children[c]!);
    const next: number[][] = [];
    for (const left of combos) for (const right of sub) next.push([...left, ...right]);
    combos = next;
  }
  return out.concat(combos);
}

/** Lay the fixture out with the nested layout; the tree's geometry follows it — each module on its disc,
 *  as the engine places it — and the discs and positions are returned. */
function laidOut(fx: Fixture): { tree: LODTree; discs: BoundaryDiscs; positions: Float32Array; byPath: Map<string, number> } {
  const tree = buildModuleLODTree(fx.records.length, fx.records, fx.edges, fx.links);
  const topo = { ...tree, parent: tree.parent! };
  const result = nestedLayout(topo, { iterations: 60 });
  const discs = nestedBoundaryDiscs(topo, result);
  computeLODPositions(tree, result.positions, discs);
  return { tree, discs, positions: result.positions, byPath: idsByPath(tree) };
}

/** A cut's expanded modules: every strict ancestor of a cut node, except the root (the whole network). */
function expandedOf(tree: LODTree, cutNodes: number[]): number[] {
  const parent = tree.parent!;
  const out = new Set<number>();
  for (const g of cutNodes) for (let x = parent[g]!; x >= 0 && parent[x]! >= 0; x = parent[x]!) out.add(x);
  return [...out];
}

function collector(ids: number[], discs?: BoundaryDiscs): CutBoundaries {
  return { radius: discs?.r, ids: Uint32Array.from(ids), alpha: new Float32Array(ids.length).fill(1), count: ids.length };
}

/** The drawn directed pairs (`"a:b"` → flow), failing on a pair drawn twice. */
function drawnPairs(out: { ids: number[]; flows?: number[] }, size: number): Map<string, number> {
  const m = new Map<string, number>();
  out.ids.forEach((id, e) => {
    const a = Math.floor(id / size);
    const key = `${a}:${id - a * size}`;
    expect(m.has(key), `pair ${key} drawn twice`).toBe(false);
    m.set(key, out.flows![e]!);
  });
  return m;
}

const sorted = (m: Map<string, number>): [string, number][] => [...m].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

/**
 * The oracle, for a present set `present` (a cut, or a decluttered subset of one) and the cut's expanded
 * modules `expanded`, everything on screen. Every edge (graph edge or module link) with both endpoints
 * under present nodes is drawn there (#325). A module link with an endpoint that has no present cover but
 * is expanded is **anchored**: drawn from/to that module itself (its boundary), the other end at its
 * cover — or at itself when also expanded — even when the two boundaries overlap (it then runs between
 * their centres). Nothing else is drawn.
 */
function expectedPairs(tree: LODTree, discs: BoundaryDiscs, fx: Fixture, byPath: Map<string, number>, present: number[], expanded: number[]): { pairs: Map<string, number>; anchored: number; overlapped: number } {
  const parent = tree.parent!;
  const isPresent = new Set(present);
  const isExpanded = new Set(expanded);
  const cover = (x: number): number => {
    for (let y = x; y >= 0; y = parent[y]!) if (isPresent.has(y)) return y;
    return -1;
  };
  const nested = (a: number, b: number): boolean => {
    for (let x = parent[a]!; x >= 0; x = parent[x]!) if (x === b) return true;
    for (let x = parent[b]!; x >= 0; x = parent[x]!) if (x === a) return true;
    return false;
  };
  const pairs = new Map<string, number>();
  const add = (a: number, b: number, w: number): void => {
    const key = `${a}:${b}`;
    pairs.set(key, (pairs.get(key) ?? 0) + w);
  };
  const all: [number, number, number, boolean][] = [];
  for (let e = 0; e < fx.edges.source.length; e++) all.push([fx.edges.source[e]!, fx.edges.target[e]!, fx.edges.weight[e]!, false]);
  for (const l of fx.links) all.push([byPath.get(Array.from(l.source).join(":"))!, byPath.get(Array.from(l.target).join(":"))!, l.flow, true]);
  let anchored = 0;
  let overlapped = 0;
  // A boundary end's circle, and whether an anchored pair's two ends are clear of each other.
  const circle = (x: number, onBoundary: boolean): [number, number, number] => {
    if (!onBoundary) return [tree.cx[x]!, tree.cy[x]!, 0];
    return [tree.cx[x]!, tree.cy[x]!, discs.r[x - tree.leafCount]!];
  };
  for (const [u, v, w, isLink] of all) {
    if (u === v || nested(u, v)) continue;
    const a = cover(u);
    const b = cover(v);
    if (a >= 0 && b >= 0) {
      if (a !== b) add(a, b, w);
      continue;
    }
    if (!isLink) continue; // a graph edge is drawn at its covers or not at all
    const onU = a < 0 && isExpanded.has(u);
    const onV = b < 0 && isExpanded.has(v);
    if (!(onU || onV)) continue;
    const ra = a >= 0 ? a : onU ? u : -1;
    const rb = b >= 0 ? b : onV ? v : -1;
    if (ra < 0 || rb < 0) continue; // the other end is decluttered away
    const [ax, ay, aR] = circle(ra, onU);
    const [bx, by, bR] = circle(rb, onV);
    if (!(Math.hypot(bx - ax, by - ay) > aR + bR)) overlapped++; // still drawn, centre to centre
    add(ra, rb, w);
    anchored++;
  }
  return { pairs, anchored, overlapped };
}

describe("module links anchored at expanded modules' boundaries (#329)", () => {
  const fixtures = [ftreeFixture(1, 12, 4), ftreeFixture(2, 14, 3), ftreeFixture(3, 10, 5), ftreeFixture(4, 16, 3)];
  for (const fx of fixtures) {
    it(`draws every module link once, at its covers or its expanded ends, on every cut: ${fx.label}`, () => {
      const { tree, discs, byPath } = laidOut(fx);
      const root = tree.size - 1;
      const cuts = cutsOf(tree, root);
      const r = rng(77);
      let anchoredTotal = 0;
      let overlappedTotal = 0;
      for (const cutNodes of cuts) {
        const expanded = expandedOf(tree, cutNodes);
        const subset = cutNodes.filter(() => r() < 0.7); // a decluttered frontier: same expanded set
        for (const present of [cutNodes, subset]) {
          const want = expectedPairs(tree, discs, fx, byPath, present, expanded);
          const got = drawnPairs(superEdges(tree, Uint32Array.from(present), { ...STYLE, anchor: collector(expanded, discs) }, ALL), tree.size);
          expect(sorted(got), `cut [${present.join(",")}]`).toEqual(sorted(want.pairs));
          anchoredTotal += want.anchored;
          overlappedTotal += want.overlapped;
        }
      }
      // Non-vacuity: plenty of links really were anchored (nested discs next to never overlap).
      expect(anchoredTotal).toBeGreaterThan(cuts.length);
      expect(overlappedTotal).toBeLessThan(anchoredTotal / 50);
    });
  }

  it("anchors only with cross-level edges on — off, the output is unchanged", () => {
    const fx = fixtures[0]!;
    const { tree, discs } = laidOut(fx);
    for (const cutNodes of cutsOf(tree, tree.size - 1)) {
      const frontier = Uint32Array.from(cutNodes);
      const off = { ...STYLE, crossLevelEdges: false };
      const withAnchor = superEdges(tree, frontier, { ...off, anchor: collector(expandedOf(tree, cutNodes), discs) }, ALL);
      expect(withAnchor.ids).toEqual(superEdges(tree, frontier, off, ALL).ids);
    }
  });

  it("leaves a raw network (no module links) byte-identical", () => {
    const fx = fixtures[1]!;
    const tree = buildModuleLODTree(fx.records.length, fx.records, fx.edges); // graph edges only
    const topo = { ...tree, parent: tree.parent! };
    const result = nestedLayout(topo, { iterations: 40 });
    const discs = nestedBoundaryDiscs(topo, result);
    computeLODPositions(tree, result.positions, discs);
    expect(tree.moduleLinkOffset).toBeUndefined();
    for (const cutNodes of cutsOf(tree, tree.size - 1)) {
      const frontier = Uint32Array.from(cutNodes);
      const a = superEdges(tree, frontier, { ...STYLE, anchor: collector(expandedOf(tree, cutNodes), discs) }, ALL);
      const b = superEdges(tree, frontier, STYLE, ALL);
      expect(a.ids).toEqual(b.ids);
      expect(a.flows).toEqual(b.flows);
      expect(a.lines?.sources).toEqual(b.lines?.sources);
      expect(a.lines?.targets).toEqual(b.lines?.targets);
    }
  });

  // A hand-sized .ftree: top modules 1 and 2, each with sub-modules x:1 and x:2 of two leaves.
  const records: ModuleNode[] = [];
  for (let t = 1; t <= 2; t++) for (let s = 1; s <= 2; s++) for (let l = 1; l <= 2; l++) records.push({ id: records.length, path: [t, s, l] });
  const links: ModuleLink[] = [
    { source: [1], target: [2], flow: 5 },
    { source: [2], target: [1], flow: 3 },
    { source: [1, 1], target: [1, 2], flow: 2 },
    { source: [1, 1], target: [2, 2], flow: 7 }, // a cousin link, across depths of the cover
  ];
  const small = laidOut({ label: "small", records, edges: { source: [0, 2, 4, 6], target: [1, 3, 5, 7], weight: [1, 1, 1, 1] }, links });
  const id = (p: string): number => small.byPath.get(p)!;

  it("draws the top-level link from/to the expanded module's boundary — with its own flow", () => {
    const { tree, discs } = small;
    // Module 1 open to its sub-modules, module 2 collapsed: 1 → 2 and 2 → 1 run from 1's ring.
    const frontier = [id("1:1"), id("1:2"), id("2")];
    const got = drawnPairs(superEdges(tree, Uint32Array.from(frontier), { ...STYLE, anchor: collector([id("1")], discs) }, ALL), tree.size);
    expect(got.get(`${id("1")}:${id("2")}`)).toBe(5);
    expect(got.get(`${id("2")}:${id("1")}`)).toBe(3);
    expect(got.get(`${id("1:1")}:${id("1:2")}`)).toBe(2); // siblings both present: a plain super-edge
    // Without the boundary the module links are lost (nothing finer carries them).
    const plain = drawnPairs(superEdges(tree, Uint32Array.from(frontier), STYLE, ALL), tree.size);
    expect(plain.has(`${id("1")}:${id("2")}`)).toBe(false);
  });

  it("runs a link between two expanded modules ring to ring, once", () => {
    const { tree, discs } = small;
    const frontier = [id("1:1"), id("1:2"), id("2:1"), id("2:2")];
    const got = drawnPairs(superEdges(tree, Uint32Array.from(frontier), { ...STYLE, anchor: collector([id("1"), id("2")], discs) }, ALL), tree.size);
    expect(got.get(`${id("1")}:${id("2")}`)).toBe(5);
    expect(got.get(`${id("2")}:${id("1")}`)).toBe(3);
    // The cousin link 1:1 → 2:2 is between present nodes: a plain super-edge.
    expect(got.get(`${id("1:1")}:${id("2:2")}`)).toBe(7);
  });

  it("anchors a link whose present cover is shallower than its expanded end", () => {
    const { tree, discs } = small;
    // Module 1 collapsed, module 2 open down to leaves: the cousin link 1:1 → 2:2 runs 1 → ring of 2:2.
    const frontier = [id("1"), id("2:1"), id("2:2:1"), id("2:2:2")];
    const got = drawnPairs(superEdges(tree, Uint32Array.from(frontier), { ...STYLE, anchor: collector([id("2"), id("2:2")], discs) }, ALL), tree.size);
    expect(got.get(`${id("1")}:${id("2:2")}`)).toBe(7);
    expect(got.get(`${id("1")}:${id("2")}`)).toBe(5);
    expect(got.get(`${id("2")}:${id("1")}`)).toBe(3);
  });

  it("draws a link once when the pair of its end's off-screen expanded ancestor holds it too", () => {
    // Module 1 open to 1:1's leaves near the origin; 1:2 far left drags module 1's centroid off-screen, so
    // the off-screen rule follows module 2's in-pair 1 → 2 — which holds the flow the link already draws.
    const recs: ModuleNode[] = [[1, 1, 1], [1, 1, 2], [1, 2, 1], [1, 2, 2], [2, 1, 1], [2, 1, 2], [2, 2, 1]].map((path, id) => ({ id, path }));
    const positions = new Float32Array([0, 0, 2, 0, -9000, 0, -9002, 0, 30, 0, 32, 2, 36, -2]);
    const view = { minX: -50, maxX: 50, minY: -50, maxY: 50 };
    const cases: [string, { source: number[]; target: number[]; weight: number[] } | undefined, ModuleLink[] | undefined][] = [
      ["anchored module link 1:1 → 2:1", undefined, [{ source: [1, 1], target: [2, 1], flow: 7 }]],
      ["projected graph edge", { source: [0], target: [4], weight: [7] }, undefined],
    ];
    for (const [label, edges, moduleLinks] of cases) {
      const tree = buildModuleLODTree(7, recs, edges, moduleLinks);
      computeLODPositions(tree, positions);
      const byPath = idsByPath(tree);
      const at = (p: string): number => byPath.get(p)!;
      expect(tree.cx[at("1")]).toBeLessThan(view.minX); // the premise: module 1's centroid is off-screen
      const anchor = collector([at("1:1"), at("1")]);
      const got = drawnPairs(superEdges(tree, Uint32Array.from([0, 1, at("2")]), { ...STYLE, anchor }, view), tree.size);
      // From 1:1's ring (the link) or from leaf 0 (the edge) to module 2 — and not again from module 1.
      expect(sorted(got), label).toEqual([[`${moduleLinks ? at("1:1") : 0}:${at("2")}`, 7]]);
    }
  });

  it("draws a link whose circles overlap between their centres — the centroid + extent fallback", () => {
    // No discs (any non-nested layout): each ring is its members' centroid + extent. Modules 1 and 2 are
    // spread along x and interleave, so their circles overlap — the link must still be drawn.
    const tree = buildModuleLODTree(records.length, records, undefined, links);
    computeLODPositions(tree, new Float32Array([-20, 0, -10, 0, 10, 0, 20, 0, -18, 6, -8, 6, 8, 6, 18, 6]));
    const byPath = idsByPath(tree);
    const at = (p: string): number => byPath.get(p)!;
    const [m1, m2] = [at("1"), at("2")];
    expect(Math.hypot(tree.cx[m2]! - tree.cx[m1]!, tree.cy[m2]! - tree.cy[m1]!)).toBeLessThan(tree.extent[m1]! + tree.extent[m2]!);
    const frontier = Uint32Array.from([at("1:1"), at("1:2"), at("2:1"), at("2:2")]);
    const out = superEdges(tree, frontier, { ...STYLE, anchor: collector([m1, m2]) }, ALL);
    const got = drawnPairs(out, tree.size);
    expect(got.get(`${m1}:${m2}`)).toBe(5);
    expect(got.get(`${m2}:${m1}`)).toBe(3);
    const e = out.ids.indexOf(m1 * tree.size + m2);
    expect(Array.from(out.lines!.sources.slice(e * 2, e * 2 + 2))).toEqual([tree.cx[m1], tree.cy[m1]]);
    expect(Array.from(out.lines!.targets.slice(e * 2, e * 2 + 2))).toEqual([tree.cx[m2], tree.cy[m2]]);
    // A present glyph inside an anchored module's circle: module 1 open, module 2 collapsed within its ring.
    const inside = drawnPairs(superEdges(tree, Uint32Array.from([at("1:1"), at("1:2"), m2]), { ...STYLE, anchor: collector([m1]) }, ALL), tree.size);
    expect(inside.get(`${m1}:${m2}`)).toBe(5);
    expect(inside.get(`${m2}:${m1}`)).toBe(3);
  });

  it("puts a boundary end on the module's circle, at radius 0 (lines, arrowheads and half-arrows)", () => {
    const { tree, discs } = small;
    const m1 = id("1");
    const cx = tree.cx[m1]!; // on its disc: the disc centre
    const cy = tree.cy[m1]!;
    const R = discs.r[m1 - tree.leafCount]!;
    const frontier = Uint32Array.from([id("1:1"), id("1:2"), id("2")]);
    const anchor = collector([m1], discs);
    tree.radius.fill(2); // glyph radii, so a boundary end's 0 is told apart from a glyph end's
    const lines = superEdges(tree, frontier, { ...STYLE, anchor }, ALL);
    const e = lines.ids.indexOf(m1 * tree.size + id("2"));
    expect(e).toBeGreaterThanOrEqual(0);
    const sx = lines.lines!.sources[e * 2]!;
    const sy = lines.lines!.sources[e * 2 + 1]!;
    expect(Math.hypot(sx - cx, sy - cy)).toBeCloseTo(R, 3);
    // The other end stays at module 2's centre; the arrowhead's tip sits there at 2's glyph radius.
    expect(lines.lines!.targets[e * 2]).toBeCloseTo(tree.cx[id("2")]!, 3);
    const back = lines.ids.indexOf(id("2") * tree.size + m1);
    expect(Math.hypot(lines.lines!.targets[back * 2]! - cx, lines.lines!.targets[back * 2 + 1]! - cy)).toBeCloseTo(R, 3);
    expect(lines.arrows!.radii[back]).toBe(0); // tip on the ring
    const half = superEdges(tree, frontier, { ...STYLE, linkStyle: "half-arrow", anchor }, ALL);
    const h = half.ids.indexOf(m1 * tree.size + id("2"));
    expect(half.halfArrows!.radii[h * 2]).toBe(0); // the boundary end
    expect(half.halfArrows!.radii[h * 2 + 1]).toBe(tree.radius[id("2")]); // the glyph end
  });
});

describe("module-link rows by own endpoint (#329)", () => {
  it("indexes each module link under its aggregate endpoints, summed per pair, skipping in-subtree links", () => {
    const records: ModuleNode[] = [
      { id: 0, path: [1, 1, 1] },
      { id: 1, path: [1, 1, 2] },
      { id: 2, path: [1, 2, 1] },
      { id: 3, path: [2, 1] },
    ];
    const links: ModuleLink[] = [
      { source: [1, 1], target: [1, 2], flow: 2 },
      { source: [1, 1], target: [1, 2], flow: 3 }, // repeated pair: summed
      { source: [1], target: [2], flow: 4 },
      { source: [2, 1], target: [1, 1], flow: 5 }, // leaf → module: only in the target's in-row
      { source: [1, 1, 1], target: [1], flow: 99 }, // into its own ancestor: left out
    ];
    const tree = buildModuleLODTree(4, records, undefined, links);
    const byPath = idsByPath(tree);
    const row = (off: Uint32Array, other: Uint32Array, flow: Float32Array, g: number): [number, number][] => {
      const o = g - tree.leafCount;
      const out: [number, number][] = [];
      for (let p = off[o]!; p < off[o + 1]!; p++) out.push([other[p]!, flow[p]!]);
      return out;
    };
    const out = (p: string) => row(tree.moduleLinkOffset!, tree.moduleLinkTarget!, tree.moduleLinkFlow!, byPath.get(p)!);
    const inn = (p: string) => row(tree.moduleLinkInOffset!, tree.moduleLinkInSource!, tree.moduleLinkInFlow!, byPath.get(p)!);
    expect(tree.moduleLinkOffset).toHaveLength(tree.size - tree.leafCount + 1);
    expect(out("1:1")).toEqual([[byPath.get("1:2"), 5]]);
    expect(inn("1:2")).toEqual([[byPath.get("1:1"), 5]]);
    expect(out("1")).toEqual([[byPath.get("2"), 4]]);
    expect(inn("1:1")).toEqual([[3, 5]]); // the leaf 2:1 is id 3
    expect(inn("1")).toEqual([]); // the in-subtree link is gone
    expect(out("2")).toEqual([]);
  });

  it("is absent on a tree built without module links", () => {
    const tree = buildModuleLODTree(2, [{ id: 0, path: [1, 1] }, { id: 1, path: [2, 1] }], { source: [0], target: [1], weight: [1] });
    expect(tree.moduleLinkOffset).toBeUndefined();
    expect(tree.moduleLinkInOffset).toBeUndefined();
  });
});

describe("nestedBoundaryDiscs (#329)", () => {
  it("re-expresses every module disc relative to its leaf centroid", () => {
    const fx = ftreeFixture(5, 16, 4);
    const tree = buildModuleLODTree(fx.records.length, fx.records, fx.edges, fx.links);
    const topo = { ...tree, parent: tree.parent! };
    const result = nestedLayout(topo);
    const discs = nestedBoundaryDiscs(topo, result);
    computeLODPositions(tree, result.positions);
    expect(discs.r).toHaveLength(tree.size - tree.leafCount);
    for (let g = tree.leafCount; g < tree.size; g++) {
      const o = g - tree.leafCount;
      expect(tree.cx[g]! + discs.dx[o]!).toBeCloseTo(result.cx[g]!, 2);
      expect(tree.cy[g]! + discs.dy[o]!).toBeCloseTo(result.cy[g]!, 2);
      expect(discs.r[o]).toBe(result.r[g]);
    }
  });

  it("places each module on its disc through computeLODPositions: centre and radius, grown only to hold a member", () => {
    const fx = ftreeFixture(5, 16, 4);
    const tree = buildModuleLODTree(fx.records.length, fx.records, fx.edges, fx.links);
    const topo = { ...tree, parent: tree.parent! };
    const result = nestedLayout(topo);
    const discs = nestedBoundaryDiscs(topo, result);
    const positions = result.positions.slice();
    computeLODPositions(tree, positions, discs);
    for (let g = tree.leafCount; g < tree.size; g++) {
      expect(tree.cx[g]).toBeCloseTo(result.cx[g]!, 2);
      expect(tree.cy[g]).toBeCloseTo(result.cy[g]!, 2);
      expect(tree.extent[g]).toBeCloseTo(result.r[g]!, 2); // every member inside: the disc's radius
    }
    // A leaf moved far out of its module (a drag, a transition): the disc follows its centroid, and the
    // extent grows to bound it, so the cut still culls the module by a box that holds every member.
    const leaf = 0;
    const m = tree.parent![leaf]!;
    const before = [tree.cx[m]!, tree.cy[m]!];
    positions[0] = positions[0]! + 1000;
    computeLODPositions(tree, positions, discs);
    expect(tree.cx[m]).toBeCloseTo(before[0]! + 1000 / tree.count[m]!, 2);
    expect(tree.cy[m]).toBeCloseTo(before[1]!, 2);
    for (let a = m; a >= 0; a = tree.parent![a]!) {
      expect(Math.hypot(positions[0]! - tree.cx[a]!, positions[1]! - tree.cy[a]!)).toBeLessThanOrEqual(tree.extent[a]! + 1e-3);
    }
  });
});

// ---- The cut's boundary collection -----------------------------------------------------------------

/** 3 top modules × 3 sub-modules × 12 leaves, laid out nested; sub-module 1:1 holds a sub-sub-module.
 *  `centroid` is the same map with the members' centroid + extent geometry (no discs). */
function mapFixture(): { tree: LODTree; centroid: LODTree; discs: BoundaryDiscs; byPath: Map<string, number> } {
  const records: ModuleNode[] = [];
  for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++) for (let c = 1; c <= 12; c++) records.push({ id: records.length, path: a === 1 && b === 1 && c <= 4 ? [a, b, 13, c] : [a, b, c] });
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 1; i < records.length; i++) {
    source.push(i - 1);
    target.push(i);
  }
  const edges = { source, target, weight: source.map(() => 1) };
  const map = laidOut({ label: "map", records, edges, links: [] });
  const centroid = buildModuleLODTree(records.length, records, edges);
  computeLODPositions(centroid, map.positions);
  return { ...map, centroid };
}

/** The cut, written out recursively — the oracle for what it expands (no fade): every module it opens
 *  whose circle (centre + extent) meets the view. */
function referenceCollected(tree: LODTree, t: LODTransform, expandPx: number): number[] {
  const v = visibleWorldRect(t, W, H);
  const out: number[] = [];
  const boxMeets = (g: number): boolean => {
    const m = tree.extent[g]! + tree.radius[g]!;
    return !(tree.cx[g]! + m < v.minX || tree.cx[g]! - m > v.maxX || tree.cy[g]! + m < v.minY || tree.cy[g]! - m > v.maxY);
  };
  const circleMeets = (g: number): boolean => {
    const x = tree.cx[g]!;
    const y = tree.cy[g]!;
    const qx = Math.min(Math.max(x, v.minX), v.maxX);
    const qy = Math.min(Math.max(y, v.minY), v.maxY);
    return Math.hypot(x - qx, y - qy) <= tree.extent[g]!;
  };
  const visit = (g: number): void => {
    if (g < tree.leafCount || !boxMeets(g)) return;
    if (2 * tree.extent[g]! * t.k < expandPx) return;
    if (tree.parent![g]! >= 0 && circleMeets(g)) out.push(g);
    for (let c = tree.childOffset[g]!; c < tree.childOffset[g + 1]!; c++) visit(tree.children[c]!);
  };
  visit(tree.size - 1);
  return out.sort((a, b) => a - b);
}

describe("cut collects the expanded modules in view (#329)", () => {
  const { tree, centroid, discs, byPath } = mapFixture();
  const expandPx = 120;
  // A sweep: framed, zoomed in on several spots (centres, module edges, the map's rim), and panned off.
  const views: LODTransform[] = [];
  const rootR = tree.extent[tree.size - 1]!;
  for (const k of [0.4, 1, 2.5, 6, 14]) {
    for (const [fx, fy] of [[0, 0], [0.5, 0.2], [-0.7, 0.6], [1.05, 0], [0.2, -1.1], [3, 3]]) {
      const x = tree.cx[tree.size - 1]! + fx * rootR;
      const y = tree.cy[tree.size - 1]! + fy * rootR;
      views.push({ k, x: W / 2 - x * k, y: H / 2 - y * k });
    }
  }

  it("leaves the frontier unchanged, and collects exactly what the cut expands", () => {
    let collected = 0;
    for (const tr of [tree, centroid]) { // modules on their discs, and on their members' centroid + extent
      for (const t of views) {
        const bnd = makeCutBoundaries();
        const plain = Array.from(cut(tr, t, W, H, { expandPx }));
        const withRings = Array.from(cut(tr, t, W, H, { expandPx, boundaries: bnd }));
        expect(withRings).toEqual(plain);
        const got = Array.from(bnd.ids.subarray(0, bnd.count)).sort((a, b) => a - b);
        expect(got).toEqual(referenceCollected(tr, t, expandPx));
        expect(Array.from(bnd.alpha.subarray(0, bnd.count)).every((a) => a === 1)).toBe(true);
        collected += bnd.count;
      }
    }
    expect(collected).toBeGreaterThan(views.length); // non-vacuity: the sweep really opens modules
  });

  it("never collects the root, nor a module that is drawn collapsed", () => {
    const t: LODTransform = { k: 6, x: W / 2 - tree.cx[tree.size - 1]! * 6, y: H / 2 - tree.cy[tree.size - 1]! * 6 };
    const bnd = makeCutBoundaries();
    const frontier = new Set(cut(tree, t, W, H, { expandPx, boundaries: bnd }));
    const got = Array.from(bnd.ids.subarray(0, bnd.count));
    expect(got.length).toBeGreaterThan(0);
    expect(got).not.toContain(tree.size - 1);
    for (const g of got) expect(frontier.has(g)).toBe(false);
  });

  it("reaches a module's rim past its members by the ordinary walk: the disc is the module's geometry", () => {
    // On its disc, module 1's rim is part of the module to the cut: visited, opened and ringed there like
    // anywhere else in it. On its members' centroid + extent the same spot is outside its cull box.
    const m = byPath.get("1")!;
    const root = tree.size - 1;
    const r = tree.extent[m]!;
    expect(r).toBeCloseTo(discs.r[m - tree.leafCount]!, 3);
    const k = 400; // a 2 × 1.5 world-unit view
    const box = (tr: LODTree, g: number, v: ReturnType<typeof visibleWorldRect>): boolean => {
      const e = tr.extent[g]!;
      return !(tr.cx[g]! + e < v.minX || tr.cx[g]! - e > v.maxX || tr.cy[g]! + e < v.minY || tr.cy[g]! - e > v.maxY);
    };
    // A spot just inside the rim whose view misses every other node's box (and module 1's centroid box).
    let t: LODTransform | null = null;
    for (let deg = 0; deg < 360 && !t; deg++) {
      const a = (deg * Math.PI) / 180;
      const qx = tree.cx[m]! + (r - 0.25) * Math.cos(a);
      const qy = tree.cy[m]! + (r - 0.25) * Math.sin(a);
      const at: LODTransform = { k, x: W / 2 - qx * k, y: H / 2 - qy * k };
      const v = visibleWorldRect(at, W, H);
      let clear = !box(centroid, m, v);
      for (let g = 0; g < tree.size && clear; g++) if (g !== m && g !== root && box(tree, g, v)) clear = false;
      if (clear) t = at;
    }
    expect(t, "a rim spot clear of every member").not.toBeNull();
    const px = 2 * r * k * 0.99; // module 1 (and the root) open
    for (const [tr, rings] of [[tree, [m]], [centroid, []]] as const) {
      const bnd = makeCutBoundaries();
      const frontier = Array.from(cut(tr, t!, W, H, { expandPx: px, boundaries: bnd }));
      expect(frontier).toEqual(Array.from(cut(tr, t!, W, H, { expandPx: px })));
      expect(frontier).toEqual([]); // nothing drawn out there
      expect(Array.from(bnd.ids.subarray(0, bnd.count))).toEqual(rings);
      expect(referenceCollected(tr, t!, px)).toEqual(rings);
    }
  });

  it("does not collect an expanded module whose boundary misses the view (a corner of its cull box)", () => {
    const m = byPath.get("2")!;
    const k = 400;
    // Inside module 2's cull box (centre ± extent), outside its circle.
    const qx = tree.cx[m]! + 0.9 * tree.extent[m]!;
    const qy = tree.cy[m]! + 0.9 * tree.extent[m]!;
    const t: LODTransform = { k, x: W / 2 - qx * k, y: H / 2 - qy * k };
    const bnd = makeCutBoundaries();
    cut(tree, t, W, H, { expandPx, boundaries: bnd });
    expect(Array.from(bnd.ids.subarray(0, bnd.count))).not.toContain(m);
    expect(referenceCollected(tree, t, expandPx)).not.toContain(m);
  });

  it("collects a cross-fading module with its children's alpha, and writes that alpha for it", () => {
    const fadeAlpha = new Float32Array(tree.size).fill(-1);
    let banded = 0;
    for (const t of views) {
      const bnd = makeCutBoundaries();
      const frontier = new Set(cut(tree, t, W, H, { expandPx, fadeBand: 0.3, fadeAlpha, boundaries: bnd }));
      for (let i = 0; i < bnd.count; i++) {
        const g = bnd.ids[i]!;
        const a = bnd.alpha[i]!;
        expect(a).toBeGreaterThan(0);
        expect(a).toBeLessThanOrEqual(1);
        if (frontier.has(g)) banded++; // drawn fading out AND expanded (its children fade in)
        else expect(fadeAlpha[g]).toBeCloseTo(a, 6);
      }
    }
    expect(banded).toBeGreaterThan(0);
  });
});

describe("boundaryRings (#329)", () => {
  const { tree, centroid, discs, byPath } = mapFixture();
  const m1 = byPath.get("1")!;
  const m2 = byPath.get("2")!;

  it("rings each collected module on its disc, the outer edge on the boundary, width in px at the zoom", () => {
    const bnd: CutBoundaries = { radius: discs.r, ids: Uint32Array.from([m1, m2]), alpha: Float32Array.from([1, 0.5]), count: 2 };
    const rings = boundaryRings(tree, bnd, { width: 2, color: "rgba(10, 20, 30, 0.8)", opacity: 0.5, screen: true, k: 4 }, ALL);
    expect(rings.count).toBe(2);
    expect(rings.centers[0]).toBe(tree.cx[m1]); // on its disc: the disc centre
    expect(rings.radii[0]).toBe(discs.r[m1 - tree.leafCount]);
    expect(rings.radii[0]! * rings.borders[0]!).toBeCloseTo(2 / 4, 5); // 2 px at k = 4, in world units
    expect(Array.from(rings.borderColors.subarray(0, 4))).toEqual([10, 20, 30, Math.round(255 * 0.8 * 0.5)]);
    expect(rings.borderColors[7]).toBe(Math.round(255 * 0.8 * 0.5 * 0.5)); // faded with its children
    expect(Array.from(rings.colors).every((c) => c === 0)).toBe(true); // no fill
    const world = boundaryRings(tree, bnd, { width: 2, color: "#000", opacity: 1, screen: false, k: 4 }, ALL);
    expect(world.radii[0]! * world.borders[0]!).toBeCloseTo(2, 5);
  });

  it("falls back to the centroid and extent without discs, and drops a ring that encloses the whole view", () => {
    const bnd: CutBoundaries = { ids: Uint32Array.from([m1]), alpha: Float32Array.from([1]), count: 1 };
    const rings = boundaryRings(centroid, bnd, { width: 1, color: "#000", opacity: 1, screen: false, k: 1 }, ALL);
    expect(rings.centers[0]).toBe(centroid.cx[m1]);
    expect(rings.radii[0]).toBe(centroid.extent[m1]);
    const tiny = { minX: centroid.cx[m1]! - 0.1, maxX: centroid.cx[m1]! + 0.1, minY: centroid.cy[m1]! - 0.1, maxY: centroid.cy[m1]! + 0.1 };
    expect(boundaryRings(centroid, bnd, { width: 1, color: "#000", opacity: 1, screen: false, k: 1 }, tiny).count).toBe(0);
  });
});
