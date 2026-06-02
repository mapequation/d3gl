# Infomap Bioregions Example — Design Spec

**Date:** 2026-06-02
**Status:** Approved (design); Phase 1 ready for planning

## Goal

Build a d3gl example that can recreate Figure 3 of the Infomap Bioregions paper
(Edler et al., *Syst. Biol.* 2017): a phylogenetic tree of world mammals with
ancestral-range reconstruction (pie charts at nodes, branch thickness scaled to
subtended terminals) alongside a bioregion map, with colors consistent across both.

The example demonstrates that d3gl's backend-agnostic renderer can drive the same
visualization the real Infomap Bioregions tool produces, while staying a light,
dependency-conscious *example* (not a re-implementation of the full app).

## Scope & phasing

The work is split so Figure 3a (the tree) is testable standalone before any
spatial binning / community detection exists.

- **Phase 1 (this spec, planned now):** standalone ancestral-range tree.
- **Phase 2 (separate spec/plan, later):** mock occurrences → adaptive quadtree
  binning → bipartite network → real Infomap (WASM, worker) → bioregion map with
  shared colors, side-by-side with the tree. Streaming parse optional.

## Decisions (locked)

1. **Step-1 bioregion data:** mock each species' bioregion distribution directly
   (decoupled from binning/Infomap), so tree + parsimony + rendering are testable
   in isolation.
2. **Mock tree:** procedurally generated (seeded), with a size slider (~200 …
   toward 5747 tips). No bundled external tree file.
3. **Phase-2 clustering:** real `@mapequation/infomap` (WASM) in a worker.
4. **State management:** light — React state + d3gl's imperative engine + plain TS
   data modules. No store library (MobX/Redux/zustand). This matches d3gl's existing
   pattern and avoids the per-feature reactivity overhead that slows the real v2 app.
5. **Pies (Phase 1):** world-sized (scale with zoom), with level-of-detail culling
   of tiny pies at low zoom for the large trees. Screen-constant pies are deferred.

## Architecture (Phase 1)

A new drawer entry **"Infomap Bioregions"** (`InfomapBioregions.tsx`) in the unified
example app, alongside Bioregions and PhyloTree. It reuses the PhyloTree layout
machinery (d3-hierarchy `cluster`, rectangular/radial, time scale, labels, zoom).

### Modules

**`examples/app/src/examples/mammals-data.ts`** — synthetic data.
- `makeMammalTree(nTips, seed): TreeNode` — seeded (mulberry32) birth-death-style
  tree with synthetic binomial names (`Genus species`) and branch lengths. Ages
  derive from cumulative branch length (as in the reference `rootDist`).
- `assignBioregions(root, nRegions, seed): Record<string, RegionSet>` — assign each
  subtree a "home" bioregion with occasional spillover, so sibling species tend to
  share regions. Most species get one region; some get 2–3. This produces the
  community structure that makes Fitch reconstruction (and, later, the occurrence
  field) non-trivial.

**`examples/app/src/examples/parsimony.ts`** — typed port of the reference
`geoTreeUtils.js` (Infomap Bioregions v1).
- `RegionSet = { totCount: number; clusters: { clusterId: number; count: number }[] }`
- `calcMaximumParsimony(root, clustersPerSpecies)`:
  - **Preliminary phase** (post-order): leaves presence-count their regions; each
    internal node takes the **intersection** of its children's region sets, falling
    back to **union** with a `byUnion = true` flag when the intersection is empty.
  - **Final phase** (pre-order): refine each non-root internal node against its
    parent using Fitch's ambiguity rules — diminished (keep intersection when the
    node set ⊇ parent set), expanded (union with parent when `byUnion`), encompassing
    (otherwise add only parent regions present in ≥1 child subtree).
  - Writes the reconstructed range onto `node.data.ranges` (a `RegionSet`).
- `aggregateSpeciesCount(root)`: post-order sum writing `node.data.speciesCount`
  (number of subtended terminals) → branch-thickness metric.

**`examples/app/src/examples/InfomapBioregions.tsx`** — the component.
- Layout via the existing `layout.ts` (rectangular/radial, time scale).
- `links` layer: `draw` via the existing PhyloTree link generators;
  `lineWidth: (l) => thickness(l.target.data.speciesCount)` for Fig. 3 branch scaling.
- `pies` layer: one arc-wedge drawable per `(node, region)`. `draw` emits
  `ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,a0,a1); ctx.closePath()`; `fill = (w) =>
  regionColor(w.clusterId)`. Internal nodes show the reconstructed ancestral range;
  tips show the current distribution. World-sized; LOD-cull pies below a pixel
  threshold at the current zoom for large trees.
- Tip markers + labels reuse PhyloTree's point/label approach.
- A categorical color scale per region (Phase 2 will swap in the Infomap-derived
  palette so map and tree share colors).
- Controls: backend (webgl/canvas/svg), layout, size slider, branch-thickness on/off,
  pies on/off.

### Renderer change

**`packages/map/src/plot.ts`** — `PlotLayerOptions.lineWidth?: number | ((d, i) =>
number)`. Per-drawable `lineWidth` is already supported at the drawable level
(`g.drawable(id, fn, { lineWidth })`); `plot()` currently hardcodes one constant per
layer. The change resolves a per-datum width and passes it per drawable. A test
asserts a function `lineWidth` produces distinct per-drawable widths.

## Testing

- **Parsimony (Node test):** port the reference `geoTreeUtils-test.js` Fitch fig-2b
  and fig-2f cases — small fixed trees with known leaf regions and asserted node
  reconstructions. This pins the algorithm independent of rendering.
- **Data generators (Node test):** `makeMammalTree(n, seed)` is deterministic for a
  seed, yields `n` leaves with finite branch lengths and unique names;
  `assignBioregions` covers all regions and gives most species exactly one region.
- **Renderer (browser test):** `plot.layer` with a function `lineWidth` records
  per-drawable widths.
- **Visual:** headless Playwright screenshots of the tree across backends/layouts.

## Out of scope (Phase 1)

Spatial binning, occurrence generation, the bipartite network, Infomap, the
bioregion map, cross-panel highlight, streaming parse, shapefile input. All belong
to Phase 2.
