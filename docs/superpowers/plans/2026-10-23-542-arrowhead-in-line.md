# #542: the arrowhead becomes part of the directed `line` instance (design C)

Issue: #542. Decision (user, 2026-10-23): design C — draw the arrowhead from the line instance and drop the
separate arrowhead layer, so the shaft ends inside the head and the duplicated per-link arrow data goes away.
Rejected: A (+4 B/link radius in the line lane, keeps the arrows layer), B (CPU-trimmed ends: per-zoom pass or
8 B/link re-upload per frame in screen mode). Anchors are on origin/main daae0deb unless marked #528
(origin/feat/505-self-links); the work starts after #528 and #536 merge (step 1 can start before).

## Verified facts

- `tip = tgt - dir*a_radius` (webgl/shaders.ts:400). Head template (0,0),(2,±1)·size; the one-sided head
  (2,0),(2,1) is used by bent `line` links (`half: bend !== 0`, network/glyphs.ts:2748, 2871). `arrowSize` is a
  scalar (network/network.ts:6129) → a uniform.
- The arrows layer also allocates its own highlight buffers (`HighlightBuffers`, webgl/instanced.ts:60: group,
  group2, selected, 4 B each): **44 B/link on the GPU**, not 32. `linkArrowsStyleAttrs` runs the colour accessor a
  second time over all edges (glyphs.ts:2613).
- Setback: head length 2·size and width 2·size, so `s = headLength · min(1, w/headWidth) = min(w, 2·size)`. The
  one-sided head uses the same `s`.

## Data

`InstancedLinesData` (core/backend.ts:153) gains:
- `radii?: Float32Array` — the target's radius per instance (or a per-edge table with `index`); absent = the
  WebGL constant 0 (the `zeroOffsets` pattern, instanced.ts:204), no buffer.
- `arrowSize?: number` — a draw setting like `samples`; set = the layer has a head; uniform `u_arrowSize`. Turning
  the head on/off recreates the layer, as a `samples` change does (instanced.ts:767).
- `halfHead?: boolean` — uniform `u_halfHead`.

Removed: the network's `arrows` / `leaf-arrows` layers, `LinkArrowsStyleAttrs` / `linkArrows*` (glyphs.ts
2572-2636), `SuperEdgesData.arrows` (glyphs.ts 2134-2136, 2368-2384); on #528 the `self-loop-arrows` layer,
`arrowSizes`, the arrow `zeroRadii`, `arrowFrom` / `loopArrowFrom` (8 B/loop per position frame).

| At 1M directed links | Before | After |
|---|---|---|
| Plain lane GPU per link (LOD off) | lines 40 + arrows 44 = 84 B | 44 B (−40 MB; −16 MB more in the both view) |
| Plain lane CPU kept per link | arrows keep sizes, colours, bends | radii move onto the lines (−8–12 MB) |
| Plain lane per position frame | 32 B/link allocated + uploaded | 16 B/link |
| Selection change / style change | 2 `selected` uploads / 2 colour passes | 1 / 1 |
| Indexed lane (LOD leaf links, #447) GPU per edge | lines 21 B tables + 24 B lanes, arrows 37 + 24: 106 B | 49 B (+ a 4 B `r32float` radius table): −57 MB, −4 MB CPU `ones` |
| Indexed lane per frame that changes the list | 40–48 B per drawn link | 20–24 B |
| Gathered super-edges per drawn super-edge | 84 B; 7 `StableColumns` compares; 16 B arrow ends; fresh `sizes` | 44 B; 4 compares; none |

A zoom frame with LOD off uploads nothing before and after (assert in network-sweep-perf).

## WebGL

- `lineVS(curve, head)` on #528's `lineVS(curve)`: curve snippets become `curveAt(t)` / `curveTan(t)` (quadratic
  and #528's drop cubic, core/loop-drop.ts). `head = false` is today's program byte for byte. Variants:
  {quadratic, drop} × {plain, indexed} with a head (`INDEXED_LINE_VS` gains `a_radius`).
- Template stays one vec2 at location 0: shaft `(t, side)`, t ∈ [0,1], 2M vertices; head `(2 + back, across)`:
  (2,0), (4,−1), (4,1). The VS branches on `a_corner.x > 1.5`; `u_halfHead` → `across = max(across, 0)`.
  Per instance: today's line attributes + `a_radius` (4 B).
- Draw order (Q1a): the headed layer draws twice over the same instance buffers — shafts (strip,
  `lineTemplate(M)`), then a 3-vertex head model — the pick-twin pattern (instanced.ts:713).
- Shaft trim: `T1 = curveTan(1)`, `dir = normalize(T1)`, `tip = tgt − dir·a_radius`, `s = min(a_width,
  2·u_arrowSize)`, `t1 = clamp(1 − (a_radius + s)/|T1|, 0, 1)`; sample i < M−1 at `curveAt(t·t1)` with the
  normal of `curveTan(t·t1)`; the last sample snaps to `E = tip − dir·s` with normal ⟂dir so the shaft corners
  land on the head's edges. Exact for straight links; for bent links the snap absorbs ≈ 2|bend|(r+s)²/|chord|.
- Half-arrow lane: unchanged. sizeMode: screen in px (`a_width`, `a_radius`, `u_arrowSize`), world in world
  units, a uniform branch.
- Drop loops (#528): the loop layer gets the head variant with `radii` absent (tip on the rim end);
  `curveTan(1) = 3(P3 − P2)` is today's `arrowFrom` direction; |T1| = 6r.
- Files: `InstancedLines` (instanced.ts:632-839: head models, `a_radius` via `writeIfChanged`, two uniforms);
  `IndexedLinkDraw` (webgl/indexed-links.ts:93: optional head model pair sharing lanes/tables); `TableFormat` /
  `CHANNELS` (indexed-links.ts:39-50: add `r32float`); `lineSpecs` (indexed-links.ts:351: table `u_edgeRadius`).

## Picking and highlight

- A head pixel writes the line's own `v_id` + `u_pickBase`; the arrows layers used the same ids/bases, so
  `linkResolve`, `lodLinkHit`, `noLodLinkHit` (network.ts:4191-4215) are unchanged; each line layer's
  `renderPick` also draws its head pick model.
- network.ts: drop the `arrows` branches in `flagPickableLinks` (4141-4146), `attachNoLodHighlight`
  (4158-4176), `attachOffsetChanges` (4939); remove `leaf-arrows` / `arrows` from `LAYER_NAMES` / `HL_LAYERS`
  (818, 825) in step 4; `SCENE_LAYERS` (1453) keeps the vector `arrows` group. webgl-backend.ts (264, 269-271,
  301, 316): `arrows` branches go in step 5. Hover/selection dim: one set of columns per link.

## Canvas/SVG Scene and toSVG()

- Keep the vector `arrows` group, fed from the link data: matches Q1a's order; shafts stay native strokes (exact
  curves, constant px during a gesture); #528's loop shafts stay anchored without re-bake; one drawable per
  directed link per group, as today.
- New `core/arrowhead.ts` (shared; GLSL twin): `shaftSetback(w, size)`, `trimQuadratic` / `trimDrop` (de
  Casteljau split at t1, end replaced by E), `headPoints(tip, dir, size, half)`.
- `emitLinks` (glyphs.ts:2958) and `traceSuperLines` (3173) take `{radii, size, bake}` and trim; in screen mode
  only the trim is baked (solve in ×k px, emit ÷k, keep the px stroke width). #528's `emitSelfLoops` trims in
  anchored px. `emitArrows` (2995), `traceSuperArrows` (3203) and #528's `emitSelfLoopArrows` read the link data;
  the arrows SoA is gone.
- Export: `linesToDrawables` (core/instanced-vector.ts:160) trims; `lineHeadsToDrawables(l, bake)` replaces
  `arrowsToDrawables` (196); `instancedVectorLayers` (271) emits shafts in their sizeMode, then heads baked to
  world at k in screen mode.
- Gesture end (#517): `rebuild()` already re-registers at gesture end (network.ts:5689-5706); once #517 limits
  the re-bake to screen-mode geometry, the directed `links` group joins it (the trim depends on k). During a
  screen-mode zoom-out gesture the shaft corners can peek beside the shrinking head until the gesture ends.

## LOD

- `superEdgeBatches` (glyphs.ts:2122-2137) writes `lines.radii` (`putEndRadius(bS)`), sets `arrowSize` /
  `halfHead`; `withLeafLinks` (2368) gathers `radii` from `cache.lines.radii`.
- `noLodStyleCache` (2843-2878): `radii` in `LinkLinesStyleAttrs` when directed — the same array as the indexed
  radius table, built once per style.
- `leafLinkLayers` (network.ts:5240-5324) returns `links` only; `StableColumns` keys (5369-5391): drop `arrows.*`,
  add `lines.radii`. Cross-fade: the head shares the instance's alpha (`fade` on indexed draws, shaders.ts:588).
- #528 loops on LOD: `selfLoopSubset` drops `arrowSizes`, `zeroRadii`, `arrowFrom`.

## Tests and guards

- New `network/__tests__/network-arrow-shaft.browser.test.ts`: WebGL/Canvas/SVG × straight, bent, loop,
  w > 2·size × screen/world × 2 zooms: no link-coloured pixel beside the tip outside the head; no gap.
- Update (layer list / primitive names): core/__tests__/instanced-vector.test.ts; webgl/__tests__/
  instanced.browser.test.ts (headed lines pixels + a head-pixel pick; indexed too), instanced-grow-perf;
  map/instanced-offsets.browser.test.ts; network/__tests__/glyphs.test.ts:235; network.browser,
  network-inplace-positions, network-interactive:329, state-network.browser:267, state-network-both-sizes:140,
  state-network-both-perf:62, state-network-pie-highlight-perf:57; super-edges-map-reference.ts,
  super-edges-memo/lazy/depth, half-arrow-super-edge, bent-link, spatial-rows, module-boundary,
  gpu/__tests__/_lane-growth.ts; #528's self-loops.test.ts, network-self-loops(-perf).browser.test.ts.
- Per-frame guards (LOG.md coverage map; add a row): network-sweep-perf (170-225, 628: directed leg expects
  `["lines"]`; position-frame bytes 16 B/link; `indexedLinkStats.instanceBytes` 20–24 B per drawn leaf link);
  lod-frame-waste-perf (bytes drop); super-edges-perf (line leg); selection-dim-perf (one `selected` write);
  network-vector-zoom-perf (rebuild count unchanged); network-hover-slot-perf (unchanged).
- Export equivalence (map/export-equivalence.browser.test.ts:95-156): add "wide arrows", "wide bent arrows",
  "directed loops", each at ≥ 2 zooms with the world twin as control; keep the 0 noise floor.

## Steps (each leaves main green)

1. `core/arrowhead.ts` + node tests (setback; corners on the head edges, symmetric and one-sided; quadratic and
   drop split). No callers. ~15 tool calls.
2. Lane + export converter: `InstancedLinesData` fields, head shader variants, head models in `InstancedLines` /
   `IndexedLines`, the `r32float` table, `instancedVectorLayers`. The network doesn't emit them yet. Acceptance:
   instanced.browser pixel/pick tests; instanced-vector tests. ~45 calls.
3. Network LOD off, all backends, loops included: networkLayers / noLodStyleCache / FromCache, Scene emitters,
   registerNetworkScene, self-loops, the new pixel test, export cases. Acceptance: pixel test green on 3 backends,
   export equivalence at 0, network-sweep LOD-off legs green. ~50 calls.
4. Network LOD: gathers, leaf links, registerLODScene, LOD loops; remove the WebGL layer names; perf guards.
   Acceptance: every guard above passes with its budget unchanged. ~50 calls.
5. Cleanup + docs: remove the public `arrows` primitive (core/index.ts:29, webgl/index.ts:29) if Q2 = yes; JSDoc
   network.ts:259, 293-299; website network.mdx; changeset; LOG.md ("Backend compositing equivalence": heads
   from the line instance, shaft trim; coverage-map row). ~30 calls.

## Decisions (user, 2026-10-23) — these OVERRIDE the sections above where they differ

- **One shape per link (Q1 = b).** Each directed link and its head are ONE shape: one strip per link on WebGL
  (shaft, then the head through degenerate vertices; one draw call per layer, no separate head model), one filled
  outline per link on Canvas/SVG/`toSVG()`. Screen-mode outlines are baked and snap at gesture end, as the
  Canvas/SVG heads already do. No double-blended overlap for translucent links. Paint order is per link, like any
  two overlapping links today.
- **Naming (Q2).** The public `arrows` primitive becomes the WHOLE arrow (shaft + head as one shape); `lines` stays
  headless. Today's heads-only `arrows` / `InstancedArrowsData` / `InstancedArrows` are replaced (breaking → the
  release is a minor bump, 0.13).
- **Head width (Q3).** The head reuses the half-arrow style's barb rule: it sticks out the same amount beyond the
  line on BOTH sides, so it grows with the link width and the shaft always ends inside it (setback from the tip
  where the head is as wide as the line). Find the half-arrow barb scaling and share it.
- **Bent `line` links get a full (symmetric) head**, computed from the link's own curve end tangent; the one-sided
  head stays only in the `half-arrow` style. Reason: bug seen 2026-10-23 — with `linkStyle: "line"` and a bend, the
  separately drawn heads look one-sided, bend more than their lines and some sit outside their line. Check whether
  that bug is on main (not only on the #528/#536 branches) and add a pixel test for it.
- Timing: start after the user's quota reset (2026-10-24 evening), step 1 first; steps 2–5 after #528/#536 merge.

## Risks

- Translucent links still double-blend over [s, 2·size] (smaller than today's overlap under the whole head).
- Large nodes on short bent links: the snapped last segment can show a small kink.
- 2–4 more programs compile at registration. `r32float` + `texelFetch` untested on SwiftShader (check in step 2).
