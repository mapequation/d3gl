import { describe, expect, it } from "vitest";
import { buildSuperEdges, type SuperEdgeInput } from "../lod.js";
import { buildModuleLODTree } from "../modules.js";

/**
 * `buildSuperEdges` correctness + scale (#177).
 *
 * The bug: the build accumulated directed super-edge flow in a JS `Map` keyed by `a * size + b`.
 * V8 caps a `Map` at 2²⁴ (16 777 216) entries, so a hierarchy with more distinct (ancestor-a,
 * ancestor-b) pairs than that died with `RangeError: Map maximum size exceeded` before LOD could
 * initialise. `coarsen.ts` `coarsenLevel` had already hit — and solved — exactly this, by bucketing
 * with a counting sort into flat typed arrays; this build now mirrors that.
 *
 * Two legs:
 *  1. **Equivalence (always on).** Randomised trees + graphs, checked against a straightforward
 *     `Map`-based reference. This is what actually pins the semantics: the CSR pair set, the flow
 *     sums, and the out/in transpose must match exactly. Uniform-depth trees and **ragged** ones
 *     (leaves at different depths, whose edges add depth-equalising lift pairs, #325) alike.
 *  2. **Cap crossing (`BENCH_SUPER_EDGES_BUILD`, auto-enrolled in the CI perf tier).** Builds a
 *     hierarchy whose distinct-pair count exceeds 2²⁴ — the input that used to throw. Gated because
 *     crossing the cap costs ~17M pairs however you construct it (~1 GB, tens of seconds); there is
 *     no small input that reaches a 16.7M-entry ceiling.
 */

// ---- reference implementation (the pre-#177 Map version, kept as the oracle; lift pairs #325) ----

interface SuperEdgeCSR {
  superEdgeOffset: Uint32Array;
  superEdgeTarget: Uint32Array;
  superEdgeFlow: Float32Array;
  superEdgeInOffset: Uint32Array;
  superEdgeInSource: Uint32Array;
  superEdgeInFlow: Float32Array;
}

function referenceSuperEdges(size: number, parent: Int32Array, edges: SuperEdgeInput): SuperEdgeCSR {
  const depth = new Int32Array(size);
  for (let g = size - 2; g >= 0; g--) depth[g] = depth[parent[g]!]! + 1;

  const flowByPair = new Map<number, number>();
  const add = (a: number, b: number, w: number): void => {
    const key = a * size + b;
    flowByPair.set(key, (flowByPair.get(key) ?? 0) + w);
  };
  const m = edges.source.length;
  for (let e = 0; e < m; e++) {
    let a = edges.source[e]!;
    let b = edges.target[e]!;
    if (a === b) continue;
    const w = edges.weight[e]!;
    // #325: equalising depth adds a lift pair per step (deeper node → the shallower endpoint) — unless
    // one endpoint is the other's ancestor, when the edge contributes nothing at all.
    let la = a;
    while (depth[la]! > depth[b]!) la = parent[la]!;
    let lb = b;
    while (depth[lb]! > depth[a]!) lb = parent[lb]!;
    if (la === lb) continue;
    for (let x = a; x !== la; x = parent[x]!) add(x, b, w);
    for (let y = b; y !== lb; y = parent[y]!) add(a, y, w);
    a = la;
    b = lb;
    while (a !== b) {
      add(a, b, w);
      a = parent[a]!;
      b = parent[b]!;
    }
  }

  const superEdgeOffset = new Uint32Array(size + 1);
  for (const key of flowByPair.keys()) superEdgeOffset[Math.floor(key / size) + 1]!++;
  for (let g = 0; g < size; g++) superEdgeOffset[g + 1] = superEdgeOffset[g + 1]! + superEdgeOffset[g]!;
  const total = superEdgeOffset[size]!;
  const superEdgeTarget = new Uint32Array(total);
  const superEdgeFlow = new Float32Array(total);
  const cursor = superEdgeOffset.slice(0, size);
  for (const [key, flow] of flowByPair) {
    const a = Math.floor(key / size);
    const pos = cursor[a]!;
    superEdgeTarget[pos] = key - a * size;
    superEdgeFlow[pos] = flow;
    cursor[a] = pos + 1;
  }

  const superEdgeInOffset = new Uint32Array(size + 1);
  for (const key of flowByPair.keys()) superEdgeInOffset[(key % size) + 1]!++;
  for (let g = 0; g < size; g++) superEdgeInOffset[g + 1] = superEdgeInOffset[g + 1]! + superEdgeInOffset[g]!;
  const superEdgeInSource = new Uint32Array(total);
  const superEdgeInFlow = new Float32Array(total);
  const inCursor = superEdgeInOffset.slice(0, size);
  for (const [key, flow] of flowByPair) {
    const a = Math.floor(key / size);
    const b = key - a * size;
    const pos = inCursor[b]!;
    superEdgeInSource[pos] = a;
    superEdgeInFlow[pos] = flow;
    inCursor[b] = pos + 1;
  }
  return { superEdgeOffset, superEdgeTarget, superEdgeFlow, superEdgeInOffset, superEdgeInSource, superEdgeInFlow };
}

// ---- fixtures ----------------------------------------------------------------------------------

/** Deterministic PRNG so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * A random coarsening tree: `leafCount` leaves, then each level groups the previous level into
 * buckets of `fanout` until one root remains. Parent ids are always greater than child ids, which
 * is the invariant `buildSuperEdges` relies on for its single descending depth pass.
 */
function randomTree(leafCount: number, fanout: number): { size: number; parent: Int32Array; leafCount: number } {
  const parent: number[] = [];
  let levelStart = 0;
  let levelSize = leafCount;
  for (let i = 0; i < leafCount; i++) parent.push(-1);
  while (levelSize > 1) {
    const nextSize = Math.max(1, Math.ceil(levelSize / fanout));
    const nextStart = levelStart + levelSize;
    for (let i = 0; i < levelSize; i++) parent[levelStart + i] = nextStart + Math.floor(i / fanout);
    for (let i = 0; i < nextSize; i++) parent.push(-1);
    levelStart = nextStart;
    levelSize = nextSize;
  }
  const size = parent.length;
  parent[size - 1] = size - 1; // root: self-parent, never walked past (a === b terminates first)
  return { size, parent: Int32Array.from(parent), leafCount };
}

/**
 * A **ragged** module tree (#325): leaves at depths 1..`maxDepth`, some directly under the root, built by
 * the module-tree builder that produces such trees in practice (parent ids > child ids, root last).
 */
function raggedTree(leafTarget: number, maxDepth: number, seed: number): { size: number; parent: Int32Array; leafCount: number } {
  const r = rng(seed);
  const paths: number[][] = [];
  const grow = (prefix: number[]): void => {
    const k = 2 + Math.floor(r() * 4);
    for (let i = 1; i <= k; i++) {
      const path = [...prefix, i];
      if (path.length < maxDepth && paths.length < leafTarget && r() < 0.5) grow(path);
      else paths.push(path);
    }
  };
  for (let t = 1; paths.length < leafTarget; t++) {
    if (r() < 0.85) grow([t]);
    else paths.push([t]);
  }
  const tree = buildModuleLODTree(paths.length, paths.map((path, id) => ({ id, path })));
  if (!tree.parent) throw new Error("module trees carry a parent map");
  return { size: tree.size, parent: tree.parent, leafCount: tree.leafCount };
}

/** Random edges between ANY non-root tree nodes — aggregates at other depths, and ancestor pairs too (module links). */
function randomTreeNodeEdges(size: number, m: number, seed: number): SuperEdgeInput {
  const r = rng(seed);
  const source = new Uint32Array(m);
  const target = new Uint32Array(m);
  const weight = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    source[e] = Math.floor(r() * (size - 1));
    target[e] = Math.floor(r() * (size - 1));
    weight[e] = Math.round(r() * 100) / 4;
  }
  return { source, target, weight };
}

function concatEdges(a: SuperEdgeInput, b: SuperEdgeInput): SuperEdgeInput {
  return {
    source: Uint32Array.from([...Array.from(a.source), ...Array.from(b.source)]),
    target: Uint32Array.from([...Array.from(a.target), ...Array.from(b.target)]),
    weight: Float32Array.from([...Array.from(a.weight), ...Array.from(b.weight)]),
  };
}

function randomEdges(leafCount: number, m: number, seed: number): SuperEdgeInput {
  const r = rng(seed);
  const source = new Uint32Array(m);
  const target = new Uint32Array(m);
  const weight = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    source[e] = Math.floor(r() * leafCount);
    target[e] = Math.floor(r() * leafCount);
    weight[e] = Math.round(r() * 100) / 4; // exactly representable in f32 — no summation-order drift
  }
  return { source, target, weight };
}

/** Compare two CSRs as sets of (a → b, flow), independent of within-row ordering. */
function csrPairs(offset: Uint32Array, other: Uint32Array, flow: Float32Array, size: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let g = 0; g < size; g++) {
    for (let p = offset[g]!; p < offset[g + 1]!; p++) out.set(`${g}:${other[p]!}`, flow[p]!);
  }
  return out;
}

/**
 * The out-CSR is **byte-identical** to the Map reference — offsets, targets and flow, in order.
 * Both emit a row in first-encounter order, so this is a real equality, not a set comparison.
 *
 * The in-CSR (transpose) matches on offsets and on each row's contents, but **not** on within-row
 * order: the reference emitted a row in V8 `Map` insertion order, the typed-array build emits it in
 * ascending source. Row order was never contractual — the sole consumer
 * (`glyphs.ts` `frontierLayers`, the off-screen in-edge walk) scans a row and filters, never
 * indexing positionally or pairing it against the out-CSR — and ascending-source is the more
 * canonical of the two (deterministic, and better locality than a hash-insertion permutation).
 */
function expectSameCSR(got: SuperEdgeCSR, want: SuperEdgeCSR, size: number): void {
  expect(Array.from(got.superEdgeOffset)).toEqual(Array.from(want.superEdgeOffset));
  expect(Array.from(got.superEdgeTarget)).toEqual(Array.from(want.superEdgeTarget));
  expect(Array.from(got.superEdgeFlow)).toEqual(Array.from(want.superEdgeFlow));

  expect(Array.from(got.superEdgeInOffset)).toEqual(Array.from(want.superEdgeInOffset));
  expect(csrPairs(got.superEdgeInOffset, got.superEdgeInSource, got.superEdgeInFlow, size)).toEqual(
    csrPairs(want.superEdgeInOffset, want.superEdgeInSource, want.superEdgeInFlow, size),
  );
  // …and the transpose really is the out-CSR's transpose, row by row.
  expect(csrPairs(got.superEdgeInOffset, got.superEdgeInSource, got.superEdgeInFlow, size)).toEqual(
    new Map(
      Array.from(csrPairs(got.superEdgeOffset, got.superEdgeTarget, got.superEdgeFlow, size)).map(([k, v]) => {
        const [a, b] = k.split(":");
        return [`${b}:${a}`, v] as const;
      }),
    ),
  );
}

// ---- 1. equivalence ----------------------------------------------------------------------------

describe("buildSuperEdges — equivalence with the Map reference (#177)", () => {
  const cases: Array<[string, number, number, number, number]> = [
    // label, leafCount, fanout, edgeCount, seed
    ["binary tree, sparse", 64, 2, 128, 1],
    ["binary tree, dense", 64, 2, 2000, 2],
    ["fanout 4", 200, 4, 1500, 3],
    ["fanout 8, deep-ish", 500, 8, 4000, 4],
    ["wide fanout (shallow)", 1000, 32, 5000, 5],
    ["single level (all leaves under root)", 50, 64, 600, 6],
  ];
  for (const [label, leafCount, fanout, m, seed] of cases) {
    it(`matches the reference: ${label}`, () => {
      const { size, parent } = randomTree(leafCount, fanout);
      const edges = randomEdges(leafCount, m, seed);
      expectSameCSR(buildSuperEdges(size, parent, edges), referenceSuperEdges(size, parent, edges), size);
    });
  }

  const ragged: Array<[string, number, number, number, number]> = [
    // label, leafTarget, maxDepth, edgeCount, seed
    ["ragged, shallow", 60, 3, 400, 11],
    ["ragged, deep", 300, 7, 3000, 12],
    ["ragged, wide", 1000, 4, 6000, 13],
  ];
  for (const [label, leafTarget, maxDepth, m, seed] of ragged) {
    it(`matches the reference with lift pairs (#325): ${label}`, () => {
      const { size, parent, leafCount } = raggedTree(leafTarget, maxDepth, seed);
      const edges = concatEdges(randomEdges(leafCount, m, seed), randomTreeNodeEdges(size, m / 4, seed + 1));
      const got = buildSuperEdges(size, parent, edges);
      expectSameCSR(got, referenceSuperEdges(size, parent, edges), size);
      // The build hands out the depth it used, which the gather reads to tell a lift pair.
      const depth = new Int32Array(size);
      for (let g = size - 2; g >= 0; g--) depth[g] = depth[parent[g]!]! + 1;
      expect(Array.from(got.depth!)).toEqual(Array.from(depth));
      // Non-vacuity: the tree is ragged and the CSR carries pairs between different depths.
      let lift = 0;
      for (let g = 0; g < size; g++) for (let p = got.superEdgeOffset[g]!; p < got.superEdgeOffset[g + 1]!; p++) if (depth[got.superEdgeTarget[p]!] !== depth[g]) lift++;
      expect(lift).toBeGreaterThan(0);
    });
  }

  it("adds one lift pair per level between the endpoints' depths, and nothing for an edge into an ancestor (#325)", () => {
    // u = 1:3:2:5 (depth 4), v = 2:1:7 (depth 3).
    const tree = buildModuleLODTree(2, [
      { id: 0, path: [1, 3, 2, 5] },
      { id: 1, path: [2, 1, 7] },
    ]);
    const parent = tree.parent!;
    const up = (g: number, k: number): number => (k === 0 ? g : up(parent[g]!, k - 1));
    const u = 0;
    const v = 1;
    const edges: SuperEdgeInput = {
      source: Uint32Array.from([u, v, u]),
      target: Uint32Array.from([v, u, up(u, 2)]), // u→v, v→u, and u → its own module 1:3
      weight: Float32Array.from([1, 2, 4]),
    };
    const got = buildSuperEdges(tree.size, parent, edges);
    const pairs = csrPairs(got.superEdgeOffset, got.superEdgeTarget, got.superEdgeFlow, tree.size);
    expect(new Map([...pairs].sort())).toEqual(
      new Map(
        [
          [`${u}:${v}`, 1], // lift: u (depth 4) → v
          [`${up(u, 1)}:${v}`, 1], // 1:3:2 (depth 3) → v — the first same-depth pair
          [`${up(u, 2)}:${up(v, 1)}`, 1], // 1:3 → 2:1
          [`${up(u, 3)}:${up(v, 2)}`, 1], // 1 → 2
          [`${v}:${u}`, 2], // and back: v → u (lift on the target side)
          [`${v}:${up(u, 1)}`, 2],
          [`${up(v, 1)}:${up(u, 2)}`, 2],
          [`${up(v, 2)}:${up(u, 3)}`, 2],
        ].sort(),
      ),
    );
  });

  it("handles degenerate inputs identically: no edges, all self-loops, single leaf", () => {
    const { size, parent } = randomTree(32, 2);
    const empty: SuperEdgeInput = { source: new Uint32Array(0), target: new Uint32Array(0), weight: new Float32Array(0) };
    expectSameCSR(buildSuperEdges(size, parent, empty), referenceSuperEdges(size, parent, empty), size);

    const loops: SuperEdgeInput = {
      source: Uint32Array.from([0, 5, 31, 12]),
      target: Uint32Array.from([0, 5, 31, 12]),
      weight: Float32Array.from([1, 2, 3, 4]),
    };
    expectSameCSR(buildSuperEdges(size, parent, loops), referenceSuperEdges(size, parent, loops), size);

    const one = randomTree(1, 2);
    const none: SuperEdgeInput = { source: new Uint32Array(0), target: new Uint32Array(0), weight: new Float32Array(0) };
    expect(() => buildSuperEdges(one.size, one.parent, none)).not.toThrow();
  });

  it("sums parallel edges and keeps direction distinct (a→b and b→a are separate pairs)", () => {
    const { size, parent } = randomTree(4, 4); // 4 leaves directly under a root
    const edges: SuperEdgeInput = {
      source: Uint32Array.from([0, 0, 1]),
      target: Uint32Array.from([1, 1, 0]),
      weight: Float32Array.from([1.5, 2.5, 10]),
    };
    const got = buildSuperEdges(size, parent, edges);
    expectSameCSR(got, referenceSuperEdges(size, parent, edges), size);
    // 0→1 summed to 4, 1→0 held separately at 10.
    const pairs = csrPairs(got.superEdgeOffset, got.superEdgeTarget, got.superEdgeFlow, size);
    expect(pairs.get("0:1")).toBe(4);
    expect(pairs.get("1:0")).toBe(10);
  });
});

// ---- 2. cap crossing ---------------------------------------------------------------------------

/**
 * Distinct pairs must exceed 2²⁴ for this to be the regression's actual input. Construction:
 * `W` leaves 1:1 under `W` aggregates under a root, with edges covering distinct (a,b) aggregate
 * pairs. Each edge contributes a distinct **leaf** pair *and* a distinct **aggregate** pair, so
 * `m` edges yield `2m` distinct pairs — the cheapest route to 16.7M+ that exists.
 */
function capCrossingFixture(W: number, m: number) {
  const size = 2 * W + 1;
  const parent = new Int32Array(size);
  for (let i = 0; i < W; i++) parent[i] = W + i; // leaf i → aggregate W+i
  for (let i = 0; i < W; i++) parent[W + i] = 2 * W; // aggregate → root
  parent[2 * W] = 2 * W;

  const source = new Uint32Array(m);
  const target = new Uint32Array(m);
  const weight = new Float32Array(m);
  let e = 0;
  outer: for (let a = 0; a < W; a++) {
    for (let b = 0; b < W; b++) {
      if (a === b) continue;
      source[e] = a;
      target[e] = b;
      weight[e] = 1;
      if (++e >= m) break outer;
    }
  }
  return { size, parent, edges: { source, target, weight } satisfies SuperEdgeInput, distinctPairs: 2 * e };
}

describe("buildSuperEdges — beyond V8's Map ceiling (#177)", () => {
  it.runIf(process.env.BENCH_SUPER_EDGES_BUILD)(
    "builds a hierarchy with more than 2^24 distinct super-edge pairs without throwing",
    { timeout: 600_000 },
    () => {
      const W = Number(process.env.BENCH_SUPER_EDGES_BUILD_N) || 4096;
      // 2 * m distinct pairs; we need > 2^24, so m > 8_388_608.
      const m = Math.min(W * (W - 1), 8_600_000);
      const { size, parent, edges, distinctPairs } = capCrossingFixture(W, m);
      expect(distinctPairs).toBeGreaterThan(2 ** 24); // otherwise this leg proves nothing

      const t0 = performance.now();
      const got = buildSuperEdges(size, parent, edges);
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`[super-edges-build] ${distinctPairs} distinct pairs in ${ms.toFixed(0)}ms`);

      expect(got.superEdgeOffset[size]).toBe(distinctPairs);
      expect(got.superEdgeTarget.length).toBe(distinctPairs);
      expect(got.superEdgeInSource.length).toBe(distinctPairs);
      // Flow is conserved: every edge contributed weight 1 at exactly two levels.
      let sum = 0;
      for (let i = 0; i < got.superEdgeFlow.length; i++) sum += got.superEdgeFlow[i]!;
      expect(sum).toBe(2 * m);

      if (process.env.PERF_ASSERT) {
        const ceiling = Number(process.env.PERF_SUPER_EDGES_BUILD_MS) || 120_000;
        expect(ms).toBeLessThan(ceiling);
      }
    },
  );
});
