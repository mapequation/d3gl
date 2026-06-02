# Infomap Bioregions — Phase 1 (Fig. 3a tree) Implementation Plan

> Implements `docs/superpowers/specs/2026-06-02-bioregions-fig3-design.md` (Phase 1).
> TDD, frequent commits. Steps use checkbox syntax.

**Goal:** A standalone ancestral-range phylogenetic tree (Fig. 3a): pie charts per
node (current distribution at tips, Fitch-reconstructed ancestral range at internal
nodes) with branch thickness scaled to subtended terminals, on a procedurally
generated mock mammal tree — rendered on all three d3gl backends.

**Tech stack:** TypeScript, d3-hierarchy/d3-shape/d3-scale, `@d3gl/map` `plot()` engine,
`@d3gl/labels`. Tests: vitest (Node for logic, browser for renderer), Playwright screenshots.

---

### Task 1: `plot()` per-drawable `lineWidth`

**Files:**
- Modify: `packages/map/src/plot.ts` (the `layer()` method + `PlotLayerOptions`)
- Test: `packages/map/src/__tests__/plot-linewidth.test.ts` (browser) **or** assert via
  a Canvas backend render if a Node test harness isn't available for `plot`.

Per-drawable `lineWidth` already exists (`g.drawable(id, fn, { lineWidth })`). Only
`plot()` hardcodes a single constant. Make it accept a function.

- [ ] **Step 1:** Change `PlotLayerOptions.lineWidth?: number` → `number | ((d: D, i: number) => number)`.
- [ ] **Step 2:** In `layer()`, resolve per drawable:
  ```ts
  const lw = opts.lineWidth;
  const widthOf = typeof lw === "function" ? lw : (_d: D, _i: number) => lw;
  // ...
  list.forEach((d, i) =>
    g.drawable(ids[i]!, (ctx: PathContext) => opts.draw(ctx as unknown as CanvasRenderingContext2D, d, i),
      lw != null ? { lineWidth: widthOf(d, i) } : undefined),
  );
  ```
- [ ] **Step 3:** Test that a function `lineWidth` yields distinct per-drawable widths
  (inspect the SVG backend output — `toSVG()` emits per-path `stroke-width`, which is the
  easiest cross-checkable surface). Two links with different data → different `stroke-width`.
- [ ] **Step 4:** Run the map package tests; expect pass.
- [ ] **Step 5:** Commit: `feat(map): plot layer lineWidth accepts a per-datum function`.

---

### Task 2: Fitch parsimony (`parsimony.ts`)

**Files:**
- Create: `examples/app/src/examples/parsimony.ts`
- Test: `examples/app/src/examples/parsimony.test.ts`
- Modify: `examples/app/src/examples/tree.ts` (extend `TreeNode` with optional
  `ranges?: RegionSet` and `speciesCount?: number`)

Port `../../../../bioregions1/src/client/utils/phylogeny/geoTreeUtils.js`
(`calcMaximumParsimony` two-phase + `aggregateSpeciesCount`), typed, operating on the
plain `TreeNode` tree (writes `node.ranges` and `node.speciesCount`; d3 `hierarchy`
then carries these through `node.data`).

Types:
```ts
export interface Region { clusterId: number; count: number; }
export interface RegionSet { totCount: number; clusters: Region[]; byUnion?: boolean; }
export type ClustersPerSpecies = Record<string, RegionSet>;
```

Set helpers (mirror lodash `intersectionBy`/`unionBy`/`differenceBy` on `clusterId`,
preserving first-array order):
```ts
const ids = (s: Region[]) => new Set(s.map((r) => r.clusterId));
function intersectBy(a: Region[], b: Region[]): Region[] { const bi = ids(b); return a.filter((r) => bi.has(r.clusterId)); }
function unionBy(a: Region[], b: Region[]): Region[] { const ai = ids(a); return a.concat(b.filter((r) => !ai.has(r.clusterId))); }
function differenceBy(a: Region[], b: Region[]): Region[] { const bi = ids(b); return a.filter((r) => !bi.has(r.clusterId)); }
```

Algorithm (faithful to the reference):
- **Preliminary (post-order):** leaf → presence-count (`count: 1` per region) from
  `clustersPerSpecies[node.name]` (or empty). Internal → intersection of all children;
  if empty, union (set `byUnion = true`). Reduce multi-child intersection/union by
  folding the helpers across `node.children`.
- **Final (pre-order, skip root & leaves):** `inter = intersectBy(node.ranges, parent.ranges)`.
  If `inter.length === parent.ranges.clusters.length` → keep `inter` (Rule II). Else if
  `node.ranges.byUnion` → `unionBy(node, parent)` (Rule IV). Else → Rule V:
  `diff = differenceBy(inter, parent)`; `atLeastOneInChild = union over children of
  intersectBy(diff, child)`; result = `node.ranges.clusters.concat(atLeastOneInChild)`.
- `aggregateSpeciesCount(root, speciesCount?)`: post-order; leaf `speciesCount = present ? 1 : 0`
  (default present), internal = sum of children. (Phase 1 counts every tip as 1 → subtended
  terminals, exactly the Fig. 3 branch metric.)

**Tests — port the Fitch figures (assert by sorted clusterId set, order-independent).**
Use numeric clusterIds A=0, C=1, G=2 and a small tree builder:
```ts
// builder: node(name, ...children); leaf(name)
```
- [ ] **Step 1:** Write failing tests:
  - fig 2a (preliminary only): `((00,01)0,1)` with 00=[A],01=[C],1=[A] → node 0 = {A,C}, root = {A}.
  - fig 2c (preliminary): 1=[G] → node 0 = {A,C}, root = {A,C,G}.
  - fig 2e (preliminary): `(((000,001)00,01)0,1)` 000=[A],001=[C],01=[A],1=[C] → 00={A,C}, 0={A}, root={A,C}.
  - fig 2b (full `calcMaximumParsimony`): 00=[A],01=[C],1=[A] → 0={A}, root={A}.
  - fig 2d (full): 1=[G] → 0={A,C}, root={A,C,G}.
  - fig 2f (full): the fig-2e tree → 00={A}, 0={A}, 1={C}, root={A,C}.
  - `aggregateSpeciesCount`: `(((a,b),c),(d))` all present → leaf counts 1, the `(a,b)`
    clade = 2, `((a,b),c)` = 3, root = 4.
- [ ] **Step 2:** Run, expect fail (module not implemented).
- [ ] **Step 3:** Implement `parsimony.ts`; extend `TreeNode`.
- [ ] **Step 4:** Run from repo root: `corepack pnpm@9.15.9 test parsimony`; expect pass.
- [ ] **Step 5:** Commit: `feat(example): typed Fitch parsimony port + tests (Fig 3 ancestral ranges)`.

---

### Task 3: Mock mammal data (`mammals-data.ts`)

**Files:**
- Create: `examples/app/src/examples/mammals-data.ts`
- Test: `examples/app/src/examples/mammals-data.test.ts`

```ts
export const REGION_NAMES = ["Nearctic","Neotropic","Palearctic","Afrotropic","Indomalaya","Australasia"]; // 6 default
export function makeMammalTree(nTips: number, seed?: number): TreeNode;   // synthetic "Genus species" names, branch lengths, ages
export function assignBioregions(root: TreeNode, nRegions?: number, seed?: number): ClustersPerSpecies;
```

- `makeMammalTree`: build on the existing `makeTree` shape (dated, `time`/`length`), but
  assign **binomial names**: a pool of synthetic genera (e.g. `Petro`, `Macro`, …
  procedurally combined) so each leaf is unique `"Genus species_<n>"`. Deterministic (mulberry32).
- `assignBioregions`: walk the tree; each subtree inherits a "home" region, switching
  region with small probability at internal nodes (phylogenetic clustering). Each leaf:
  home region with `count` (presence), plus a spillover region with low probability
  (~15%). Returns `clustersPerSpecies` keyed by leaf name.

- [ ] **Step 1:** Write failing tests:
  - `makeMammalTree(300, 1)` → exactly 300 leaves; all `length` finite ≥ 0; names unique;
    identical output for the same seed (deep-equal two calls), different for another seed.
  - `assignBioregions(tree, 6, 1)` → an entry per leaf; every `clusterId` in `0..5`;
    ≥ 60% of leaves have exactly one region; all six regions used at least once.
- [ ] **Step 2:** Run, expect fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `corepack pnpm@9.15.9 test mammals-data`; expect pass.
- [ ] **Step 5:** Commit: `feat(example): procedural mock mammal tree + bioregion assignment`.

---

### Task 4: `InfomapBioregions.tsx` component

**Files:**
- Create: `examples/app/src/examples/InfomapBioregions.tsx`
- Modify: `examples/app/src/App.tsx` (third drawer entry)

Reuse PhyloTree's structure (plot engine, layout, labels, zoom, link generators). On
data build: `const tree = makeMammalTree(tips, seed)`, `const cps = assignBioregions(tree)`,
`calcMaximumParsimony(tree, cps)`, `aggregateSpeciesCount(tree)`, then
`layoutRectangular/Radial(tree, …)`.

- Region color: `scaleOrdinal(schemeCategory10)` over region ids (Phase 2 swaps palette).
- **Links layer:** existing `makeLinkDraw`; `lineWidth: (l) => thickness ? widthScale(l.target.data.speciesCount) : 0.8`
  with `widthScale = scaleSqrt().domain([1, root.data.speciesCount]).range([0.4, 6])`.
- **Pies layer:** flatten nodes → wedge data. For a node at `(x,y)` with `ranges.clusters`
  (`k` regions), equal wedges (or weighted by `count`): each wedge `{cx, cy, r, a0, a1, clusterId}`.
  `draw(ctx,w){ ctx.moveTo(w.cx,w.cy); ctx.arc(w.cx,w.cy,w.r,w.a0,w.a1); ctx.closePath(); }`,
  `fill: (w) => regionColor(w.clusterId)`, `stroke:"#fff"`, `lineWidth:0.3`.
  Pie radius `r` from a small constant (world units); LOD: skip nodes whose on-screen
  radius `r * transform.k < ~1.5px` (recompute the pies layer on zoom-end, or precompute
  by depth). Phase-1 acceptable: draw all pies for the tips count slider's lower range and
  cull by `node.data.speciesCount` threshold at higher counts.
- **Tip markers + labels:** as in PhyloTree (cull labels via LabelLayer width/height).
- Controls: backend (webgl/canvas/svg), layout (rect/radial), tips slider, thickness
  toggle, pies toggle, PNG/SVG export. Light theme (reuse `btn`/`Sep`).
- Hover tip → tooltip with name + its region list.

- [ ] **Step 1:** Implement the component (no dedicated unit test — covered by Task 5 visual).
- [ ] **Step 2:** Add `{ id: "infomap", label: "Infomap Bioregions" }` to `EXAMPLES` and render `<InfomapBioregions/>`.
- [ ] **Step 3:** `corepack pnpm@9.15.9 -C examples/app exec tsc --noEmit` (typecheck); expect clean.
- [ ] **Step 4:** Commit: `feat(example): Infomap Bioregions tree — ancestral-range pies + scaled branches`.

---

### Task 5: Verify

- [ ] **Step 1:** Build all packages: `corepack pnpm@9.15.9 -r build`; expect success.
- [ ] **Step 2:** Full test run from root: `corepack pnpm@9.15.9 test`; expect all pass.
- [ ] **Step 3:** Playwright headless screenshots: dev server, select Infomap Bioregions,
  capture rectangular + radial on webgl and svg; confirm pies + variable-width branches
  render and no console errors. Save under `/tmp` and inspect.
- [ ] **Step 4:** Commit any fixes.

---

### Out of scope (Phase 2)
Occurrence generation, quadtree binning, bipartite network, Infomap WASM, the map panel,
shared-palette cross-panel highlight, streaming. Separate spec/plan.
