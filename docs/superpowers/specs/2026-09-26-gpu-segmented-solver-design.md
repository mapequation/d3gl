# GPU segmented force solver: stage 1 through the flat path, plus async readback

**Date:** 2026-09-26 (revision 2, same day)
**Status:** Draft design, pre-implementation. Revision 2 answers the webgl-feasibility,
numerics-correctness and engine-integration reviews; §18 records every finding and its verdict.
**Issues:** #333 (the primitive), #184 (GPU to renderer), #124 (convergence stop), #312, #311, #297,
#181 and #189 (later consumers), epic #106 (N8)
**Builds on:** `docs/superpowers/specs/2026-07-02-n8-gpu-layout-design.md` (N8), and the shared force
schedule on `fix/layout-seed-equilibrium` (#<seed-scale>, §8)

**Terms.** *Stage 1* is the flat layout (one segment). *Stage 2* is many segments: nested (#333),
containment (#181), state layouts (#189). *PR n* is a row of the plan in §14.

## 0. Summary

`layout({ backend: "gpu" })` works today but is not smooth. On web-NotreDame (N = 325,729 nodes,
E = 1,497,134 edges) a tick costs 45-51 ms. 80% of that goes to two passes that scatter all N points
into one pixel. Each streamed frame then blocks the main thread for about 230 ms on a synchronous
`readPixels`, so the UI runs at about 4 fps and 300 fixed ticks take 13.4 s.

This spec turns the existing `GpuForceLayout` into the **segmented solver** that #333 asks for. Nodes
live in *slots*, grouped into *segments*. Forces never cross segment boundaries, and reductions work
per segment. The flat layout is the case with exactly one segment. Stage 1 builds the primitives and
lands them through the flat path, where they fix the measured problems:

1. **Segmented reductions** with no blend contention replace both 1-px scatters. Target tick at
   325k: about 13-17 ms instead of 45-51 ms.
2. **Tile-atlas grid pyramid**: the flat layout is one tile. Levels are packed into three textures,
   so the traversal needs 3 samplers instead of 11. There is an exact loop for small segments and a
   softening per segment.
3. **Chunked CSR spring rows** remove the 4096-neighbour cap. Today the cap drops 13.5k half-edges
   on 5 web-NotreDame hubs.
4. **One solver reused across multilevel levels**, plus a **structural multilevel seed** for plain
   graphs built from the coarsening tree (#312 parity). Coarse levels are mass-weighted, as on the
   CPU (§8).
5. **An async transport**: fenced PBO readback, a **GPU time budget per frame that holds at any N**
   (a tick is cut into row bands when it is larger than the budget), a repaint throttle that bounds
   the main thread, and a **per-tick convergence stop decided on the GPU** (#124).
6. **Capability checks** (float render targets, `EXT_float_blend`, texture limits, read format) with
   a clean fallback to the worker that keeps every option (#297, #312), plus a backend-swap and
   context-loss policy (#311).

The Navigator switch to the GPU backend has one more gate: with LOD on, the GPU path must keep the
LOD geometry refit off the main thread, as the worker path does (§12.1, PR 3c).

Stage 2 reuses the same solver with many segments. The nested layout becomes **one** batched solve
over all depths plus D composition gathers (#333). #181 and #189 become consumers. GPU-resident
positions (#184) come later.

## 1. Measured baseline (M1 Max, ANGLE Metal, headless Chromium, web-NotreDame)

| Item | Today | Source |
|---|---|---|
| Tick, pyramid path | 44.5-51 ms | fenced per-pass timings |
| Centroid 1-px ADD scatter (`CentroidReducePass`) | 17.3 ms | `passes/centering.ts` |
| Bbox 1-px MAX scatter (`GridPyramid.build` step 1) | 18.8 ms | `passes/grid-pyramid.ts` |
| Barnes-Hut (BH) traversal, θ = 0.9 | 9.6-12.4 ms (7.8 ms if Morton-ordered) | `passes/repulsion-pyramid.ts` |
| CSR attraction gather | 2.1 ms | `passes/attraction.ts` |
| G×G scatter + 10 reduce passes | 0.2-0.6 ms + 0.5 ms | `passes/grid-pyramid.ts` |
| Centering apply / integrate | 0.16 ms / < 1 ms (integrate not isolated) | |
| Tick encode (main thread) | 3.3 ms per 5 ticks (~0.66 ms per tick, N-independent) | `gpu-transport.ts` `step()` |
| Readback per streamed frame | ~230 ms main-thread block (the copy itself is 2.1-2.8 ms) | `gpu-transport.ts` `step()` |
| GPU path in the app | 290 ms per 5-tick frame; `readPixels` is 74% of main-thread time; ~3.4-4 fps | browser profile |
| Worker path in the app, main thread per layout frame (LOD on) | 51.9 ms mean, 209.6 ms max (n = 61): rebuild, LOD cut, declutter, `linkStroke` parsing | browser profile |
| Main-thread LOD for the GPU backend | `buildLODTree` 244-308 ms once; `computeLODGeometry` 16-23 ms per frame | gpu-layout harness |
| LOD cut + declutter + labels per frame (fit view / zoomed) | 2-62 ms / declutter spikes 50-450 ms | lod-per-frame harness |
| 300 ticks | 13.4 s | |
| GPU memory | ~50 MB | §10 |
| Construction (CSR, uploads, shader compile, first readback) | 572 ms, one main-thread task | |
| Hubs over the 4096-neighbour cap | 5 (degrees 10,721 … 4,283), 13,507 half-edges dropped | `degstats.mjs` |
| BH accuracy vs exact | relative L2 error 0.8-2.2% at θ = 0.9 | |

The measurements come from the investigation harnesses in the session scratchpad (`gpu-layout/`,
`nested-333/`, `browser-profile/`, `lod-per-frame/`). They are not part of the repo. Only one device
was measured (see §15, Q7).

## 2. Goals and non-goals

### Goals

- A reusable **segmented GPU force solver** in `packages/d3gl/src/network/gpu/`. It uses slots
  grouped by segment and a segment table. Repulsion, springs and centering stay inside a segment.
  Reductions (centroid, bbox, extent, count, step sum) run per segment or per contiguous slot range.
  The solve is **deterministic on a given device**: the same inputs give bitwise-equal outputs,
  whatever the frame timing (§6.5).
- **Flat equals today, within stated tolerances.** On the flat path, web-NotreDame must reproduce
  today's single-pyramid forces within the bounds in §9. The documented exception is hubs above 4096
  neighbours, whose dropped springs come back.
- **Flat pays nothing for segments.** The flat path adds no per-node texture and no per-tick O(N)
  pass beyond today's. The segment id is a compile-time constant when S = 1.
- **Targets at 325k** (M1 Max, to be re-measured per PR):
  - tick ≤ ~17 ms of GPU time;
  - **transport-only main thread ≤ ~3 ms per rAF** (harvest + encode; T7 asserts it);
  - layout GPU work per frame ≤ the budget (default 10 ms, §6.5.3), so pan/zoom never waits behind
    a whole tick;
  - layout updates on screen at the rate the engine can repaint, capped by the repaint throttle
    (§6.5.4). That rate depends on engine-side work (#<lod-frame-waste>, #<lod-incoherent>, PR 3c)
    and is reported as measured, not assumed (§10.3);
  - with the seed and the stop rule, convergence in about 100-150 ticks, i.e. about **2.5-5 s** at
    the measured tick throughput under rendering (§10.3), instead of 300 fixed ticks (13.4 s).
- Plain graphs get a multilevel seed on the GPU. The worker fallback honours `multilevel` (#312).
- The GPU path adopts the shared force schedule from `fix/layout-seed-equilibrium` (§8), so CPU,
  worker and GPU run the same physics and stop by the same rule, checked per tick.
- Every phase ships on its own and maps to an issue key (§14).

### Non-goals

- **No change to the force law**: 1/d repulsion, zero-rest springs, linear centering. Two things are
  not force-law changes. Mass-weighted *coarse* seed levels are the shared schedule's multilevel seed
  (§8); the finest level keeps unit mass. The nested layout's rest-length springs and collision in
  stage 2 are the existing CPU nested algorithm.
- **A sort-based solver** (Morton sort + implicit fan-out-4 LBVH) is a follow-up issue only (§16).
- **GPU-resident positions** (#184 Milestone B): this spec only keeps the door open (§11.4).
- Changing the CPU nested algorithm's output, or re-implementing #181/#189 here. The one exception is
  a CPU bug fix that the GPU port needs first: coincident discs in `collide()` (§11.1, §16).
- The fit problems (#309/#327, loose fit box). This spec only notes that the GPU can report a bbox
  for free (§6.5.5).

What is **not** a non-goal any more: the main-thread LOD cost per streamed frame. The GPU path must
not move work onto the main thread that the worker path keeps off it (AGENTS lifecycle §5). §12.1
and PR 3c own it.

## 3. Binding decisions (from the maintainer)

1. **GPU solver.** Build #333's primitives (segmented reductions, tile-atlas grid pyramid, chunked
   CSR springs, one solver reused across multilevel levels) by **refactoring the existing
   `GpuForceLayout`**. Land them through the **flat path first** (flat = one segment); nested
   (many segments) comes later. The sort-based solver is only a follow-up issue.
2. **GPU to renderer.** First an **async (fenced, PBO) readback** with a **GPU time budget per
   frame**. GPU-resident positions (#184) come later. Revision 2 makes the budget hold at every N by
   slicing a tick into row bands (§6.5.3); without slicing, one tick at 325k (13-17 ms) or 1M
   (45-55 ms) exceeds a 10 ms budget and the decision would not be met.
3. The force law stays as it is.

## 4. Architecture

### 4.1 Layers

```
CPU prep (once per topology; pure, node-testable)   GPU pass graph (per tick, as work items)     Transport (per rAF, around the engine's render)
─────────────────────────────────────────────       ───────────────────────────────────────      ─────────────────────────────────────────────
segments.ts:  slot order + permutation              P: reduce tree → range query → stop latch    poll fences → harvest (if signalled)
              segment table, tile packing   ──►        tile scatter → packed reduce        ──►   onFrame (throttled) → engine repaint
              reduction ranges                         clear force → hub chunks                  encode items within the budget
              CSR in slot ids, hub chunks           F_b: springs, repulsion, centering (band b)  readback copy (throttled) → PBO → fence
schedule:     Cooling, stepCap, stop threshold      I:  integrate (alpha·heat, maxStep, latch)   budget fence (one per frame)
```

- **`GpuForceLayout` stays the solver class.** It is refactored in place and stays internal (not
  exported from the package). Its constructor takes a `SolverTopology` (slots, segments, ranges,
  CSR) instead of a bare `LayoutGraph`. `flatTopology(graph)` builds the S = 1 case, so every
  existing caller and test keeps its shape. A rename to `SegmentedForceSolver` would only be
  cosmetic. If wanted, it lands with gpu-nested.
- **The solver exposes work items, not `runFrame(ticks)`.** `beginTick()`, `forceBand(b, B)` and
  `integrate()` encode one item each; `runFrame(ticks)` stays as a convenience for tests
  (`= ticks × (beginTick, forceBand(0, 1), integrate)`).
- **Segments vs ranges** (the one new concept). A **segment** is an isolation unit: repulsion,
  springs and collision only act between slots of the same segment, and each segment with more than
  `exactMax` slots owns one pyramid tile. A **range** is a contiguous slot interval that the
  reductions can query. Segments are always ranges. Ranges can also nest, and they need no tile.
  This split lets one primitive serve every consumer:

  | Consumer | Segments | Ranges queried |
  |---|---|---|
  | Flat layout (stage 1) | 1 (all slots) | 1 (all slots) |
  | Multilevel seed level | 1 per level | 1 |
  | Nested (#333, stage 2) | one per parent module | = segments (+ leaf range for warm placement) |
  | Soft containment (#181) | 1 (global repulsion) | every module, nested (leaves in module-DFS slot order) |
  | State layouts (#189) | "two-phase": one per physical node; "force": 1 | one per physical node |
  | GPU LOD aggregates (#184 later, or PR 3c option B) | — | every LOD tree node (DFS order) |

### 4.2 Architecture check

Is refactoring `GpuForceLayout` right, or is the abstraction wrong? The current class is fine as a
solver *shell* (ping-pong, MRT integrate, pinned mask, stabilizer, CSR upload). Four things are
wrong:

- it assumes **one global box** (the 1×1 bbox and centroid targets);
- it has **one sampler per pyramid level**;
- it has **one class instance per multilevel level**;
- a tick is **one indivisible batch** of passes, so it cannot fit a frame budget smaller than itself.

The first three are single-segment special cases of the segmented design, not separate
abstractions. The fourth is a scheduling seam: the passes already write disjoint texels, so a tick
splits into work items without changing any shader's math. Generalising in place gives the clean
design without a second solver next to the first. The thing we must *not* do is add segment
awareness as adapters around the 1-px reductions. Those passes are the measured bottleneck and must
go, not be wrapped.

## 5. Data model

### 5.1 Slots, the texel mapping, and the permutation

- A **slot** is an index into the solver's per-node textures. **Every pass maps slot ↔ texel
  through one shared function**: a GLSL chunk `slotTexel(slot)` / `texelSlot(fragCoord)` and its TS
  twin in `textures.ts`. Stage 1 uses **row-major** in an atlas of width
  `W = atlasWidth(capacity)`, which is today's mapping: it keeps flat parity and the RG readback
  fast path (§6.5.2), and with S = 1 no GPU quad mixes segments. Stage 2 may change the mapping to
  8×8 blocks inside that one function, plus the pack pass; §11.1 makes that a measured decision in
  gpu-nested.
- Slots are **grouped by segment**: segment `s` occupies `[start_s, start_s + count_s)`.
  - Flat: one segment `[0, N)`.
  - Nested: segment = parent module. Slot order = the children CSR, with segments sorted by
    (parent depth, parent id), so each depth is one contiguous slot range (§11.1).
  - #181: leaves in module-DFS order, so each module's leaves are contiguous.
- **Node id ↔ slot permutation.** Two `Uint32Array`s kept on the CPU: `slotOf[node]` and
  `nodeOf[slot]`. The GPU needs one `r32ui` texture `slotOfNode` (N texels), and only when the
  permutation is not the identity. The permutation is used in four places:
  1. The CSR is rewritten into slot ids once, on the CPU.
  2. `setPinned` and `setHeldPositions` map node id → slot on the CPU. This is O(held), as today.
  3. The **readback pack pass** gathers positions into node-id order on the GPU (§6.5.2), so the CPU
     always receives node-id order.
  4. #184 later: the renderer reads that same node-order texture.
- Flat stage 1 uses the **identity** (no texture, compile-time `#define IDENTITY_SLOTS`). With the
  permutation in place, a Morton/Hilbert reorder of the flat layout becomes a later option with no
  API change: measured −19% BH, −10% attraction, on today's row-major mapping (§16).

### 5.2 Segment table (S texels each, atlas width `atlasWidth(S)`, `nearest` sampling)

| Texture | Format | Channels | Written |
|---|---|---|---|
| `segInfo` | `rgba32ui` | `start`, `count`, `tileOrigin = ox \| oy << 16`, `rootLevel \| flags << 8` (flags: `EXACT`, `FROZEN` for k = 1, `HAS_TILE`) | once per topology |
| `segParam` | `rgba32f` | repulsion strength, centering/gravity strength, softening ε, alpha0 | once (per-segment `alpha0` supports warm/cold nested segments) |
| `segBox` | `rgba32f` | `(maxX, maxY, −minX, −minY)`, the same packing as today's `boxTex` | per tick (range query, §6.1) |
| `segStats` | `rgba32f` | `(Σx, Σy, Σ\|v\|, count)` → centroid and mean step | per tick (range query) |

Every consumer divides by `max(count, 1)`, so an empty range yields a zero centroid and a zero step,
never NaN.

Stage 2 adds `segAnchor` (`rgba32f`: anchor x, y, γ, mode; for #181/#189) and `segShape` (`rgba32f`:
m_x, m_y, extent, scale; for nested composition). With S = 1, `segInfo`/`segParam` are still 1×1
textures. The same shader code runs; only the segment-id lookup is constant.

### 5.3 Per-slot textures

| Texture | Format | Flat | Multilevel seed levels | Nested (stage 2) | Notes |
|---|---|---|---|---|---|
| `pos` ×2 (ping-pong) | `rg32f` | yes | yes | yes | as today |
| `vel` ×2 (ping-pong) | `rg32f` | yes | yes | yes | stores the **clamped step** (as today), so Σ\|v\| is the CPU's step metric |
| `force` | `rg32f` | yes | yes | yes | ADD-blend accumulator, cleared once per tick |
| `pinned` | `r8unorm` | yes | all-zero on coarse levels | yes | as today (#183) |
| `stab` | `r32f` | yes | re-uploaded per level (weighted degree ÷ mass) | **no** (≡ 1) | today's `stabTex`; constant across cooling (§8) |
| `mass` | `r32f` | no | coarse levels only | no | finest nodes per supernode (§8); the finest level has unit mass |
| `radius` | `r32f` | no | no | yes | CPU nested radius formula |
| `slotSeg` | `r32ui` | **no** (`#define SINGLE_SEGMENT`, id 0) | no | yes | segment id per slot |
| `slotOfNode` | `r32ui` | no (identity) | no | yes | readback gather (§6.5.2) |

The `mass` and coarse-level textures are sized to the **largest coarse level**, not the capacity:
59,100 texels (0.24 MB) on web-NotreDame.

### 5.4 Springs (CSR in slot ids)

- `offsets` `r32ui` (count + 1) and `neighbors` `r32ui` (2E): today's symmetric `buildCSR`, rewritten
  into slot ids.
- `weights` `r32f`, only when a consumer has per-entry weights or rest lengths:
  - multilevel seed levels: the aggregated coarse edge weights (§8), sized to the largest coarse
    level's 2E;
  - nested: sibling weights and the collide-phase rest mode.

  The flat solver compiles without it (`#define UNIT_SPRINGS`). A multilevel solver switches between
  weighted coarse levels and the unit finest level with a uniform branch, so the finest level skips
  the fetch and no second program is compiled.
- `hubChunks` `rgba32ui` (row slot, entry start, entry end, —) and `hubPartials` `rg32f`: one texel
  per chunk of a row with more than C = 256 entries (§6.3).
- Nested springs never cross segments, because sibling links only join children of one parent. The
  CPU builder asserts this. A cross-segment entry would break isolation (tested, §13).

## 6. Primitives

All passes are luma.gl v9 (9.3.3) `Model`s. Each is a full-screen triangle over a target atlas, or
a `point-list` scatter. Uniforms go in the mutable-record pattern used today. Every texture,
framebuffer and buffer is created at construction or at `setLevel`, never per tick or per frame
(§13 spies). PR 1 lands the shared full-screen pass helper that is already listed as a TODO in
`passes/attraction.ts`, as its own commit. Six passes duplicate that setup today.

**Render-pass clear rule (luma 9.3.3).** `beginRenderPass` clears the whole attachment unless told
not to. The default `clearColor` is `RenderPass.defaultClearColor`, and `WEBGLRenderPass.clear()`
calls `gl.clear`, which ignores the viewport; only a scissor limits it. So:

- every pass that writes a **sub-rectangle** of a texture (packed tree levels, packed pyramid
  levels, row bands, per-level `setLevel` writes) passes `clearColor: false` and
  `clearDepth: false`;
- a clear of a sub-rectangle uses `parameters.scissorRect`, never the viewport;
- the shared pass helper takes the clear as a required argument, so no call site gets the default by
  omission.

T3 checks that writing level ℓ leaves levels ℓ ± 2 in the same texture bitwise unchanged.

### 6.1 Segmented reductions (contention-free)

**Problem.** `CentroidReducePass` and the pyramid bbox pass draw N points to texel (0,0). Blending
serialises on that one texel: 17.3 ms + 18.8 ms at 325k.

**Design: a 16-ary reduction tree over slot order, plus a canonical-cover range query.**

1. **Tree build.** Level 1 has `ceil(N/16)` texels, and texel j covers slots `16j … 16j+15`. Level ℓ
   texel j covers `[16^ℓ j, 16^ℓ (j+1))`. Each level is one full-screen pass. The fragment for
   output texel j does 16 `texelFetch`es from level ℓ−1, with **no blending**, and adds them
   **pairwise** (a 4-deep add tree inside the fragment, not 15 sequential adds). There are two
   reduction chains, written in the same passes by MRT (two color attachments):
   - `sum` chain `(Σx, Σy, Σ|v|, count)`, identity 0;
   - `box` chain `(maxX, maxY, −minX, −minY)`, identity −1e30.

   Level 1 applies the *map* (reads `pos` and `vel` per slot, emits `(x, y, |v|, 1)` and
   `(x, y, −x, −y)`, and writes the identity for slots ≥ count). At 325k the tree has 5 levels
   (20,359 → 1,273 → 80 → 5 → 1 texels). At 1M it also has 5 levels.
2. **Range query.** One fragment per range (per segment on the tick path). It covers
   `[start, start+count)` with aligned blocks:

   ```glsl
   // acc = identity; lvl = 0; a = start; b = start + count
   while (a < b) {
     while (a < b && (a & 15) != 0) { acc = op(acc, fetch(lvl, a)); a++; }   // unaligned head
     while (a < b && (b & 15) != 0) { b--; acc = op(acc, fetch(lvl, b)); }   // unaligned tail
     a >>= 4; b >>= 4; lvl++;
   }
   ```

   There are at most 30 fetches per level and 5 levels, so the query is bounded. Level-0 fetches
   apply the map directly. The query writes `segStats` and `segBox` by MRT. `count = 0` returns the
   identity.
3. **Level storage (luma constraint, §6.2.3).** A tree level is a 1D array packed into rows. Odd
   levels live in texture A and even levels in texture B, so a level pass never samples the texture
   it renders into. Writes into a level's rows use `beginRenderPass({ clearColor: false, parameters:
   { viewport } })` (supported by luma 9.3.3 `WEBGLRenderPass`; see the clear rule above). The query
   samples A and B (4 samplers for 2 chains).

**Properties.**
- Contention-free and gather-only: it needs **no float blending**.
- Deterministic: the fetch order and the add order are fixed.
- **min/max are exact**, so the flat `segBox` is **bitwise identical** to today's 1×1 bbox.
- **Error bound of the sums.** Each output is a float32 sum over an add tree of depth
  `D ≤ 4·L + 30·L` (4 per tree level from the pairwise fragment sum, plus up to 30 sequential query
  adds per level; the flat range `[0, N)` has no head, so `D ≤ 4·L + 15·L`). The error is bounded by
  `|Δ| ≤ D · ε · Σ|term|`, with ε = 2⁻²³. It scales with the **magnitude** of the terms, not with
  the result. For the flat centroid at 325k (L = 5, D ≤ 95, mean |x| ≈ 12k within the 18k disc), the
  worst case is ≈ 0.14 world units against a spacing of 56. Typical errors grow like √D, not D.
  Today's serial blend is a ~N-deep chain, so the tree is strictly better.
- Prefix sums are rejected: the cancellation error is too large at 1M.
- A scatter per segment is rejected: its contention is ∝ count, so S = 1 would be today's problem.
- **Not a stop signal on its own.** One NaN position makes `Σx` NaN for the whole segment. The stop
  latch and the harvest treat non-finite stats as a failure (§6.5.6).

**Uses of the outputs.**
- `segBox` feeds the tile scatter (§6.2) in place of `boxTex`.
- `segStats.xy / max(count, 1)` feeds centering (and is the pyramid root's value).
- `segStats.z / max(count, 1)` is the **mean step** of the previous tick, for the stop latch
  (§6.5.5).

**Cost.** O(N + N/15) texel reads in ≤ 6 small passes, plus O(S · 150) reads for the query. The
estimate is 0.3-0.6 ms at 325k, extrapolated from the 0.16 ms centering pass (a similar O(N)
full-screen pass); it is not measured. Memory: 2 chains × ≈ N/15 texels × 16 B ≈ **0.70 MB at 325k,
2.1 MB at 1M**.

### 6.2 Tile-atlas grid pyramid

#### 6.2.1 Tiles

- Each segment with `count > exactMax` gets a square **tile** of side `G_s`, a power of two:
  - flat: `G = chooseGrid(N)`, unchanged: `clamp(nextPow2(ceil(√N)), 16, 1024)`, so G = 1024 at
    325k;
  - other segments: `clamp(nextPow2(ceil(√k)), 8, 1024)`.
- Segments with `count ≤ exactMax` get **no tile** and use the exact loop (§6.2.4).
  - `exactMax` is a solver option. Flat keeps **4096** (today's `GPU_REPULSION_ALLPAIRS_MAX`, so the
    N ≤ 4096 all-pairs parity baseline is unchanged).
  - Nested uses **32** (the CPU `EXACT_MAX`).
- **Packing.** Sort tiles by side, descending, and place them along a Morton curve at cumulative cell
  offset `o`: `origin = demorton(o)`, then `o += G_s²`. Every earlier tile is at least as large (a
  power of two), so `o` is a multiple of `G_s²`. A Morton range that is aligned to `G_s²` decodes to
  an axis-aligned `G_s × G_s` square whose origin is a multiple of `G_s`. That is why **every tile is
  aligned at every level** and the existing 2×2 `REDUCE_FS` reduces all tiles at once, unchanged.
  - The atlas side is `A = nextPow2(ceil(√Σ G_s²))`, with height `A/2` when `Σ G_s² ≤ A²/2` (the
    Morton top bit is y, so the first half fills the bottom rows).
  - The flat layout is one tile at origin (0,0) with `A = G`, exactly today's level-0 grid.
  - The packing is pure CPU code (`segments.ts`) and node-tested.
- **Scatter.** The `point-list` ADD blend is the same as today, but the box comes from
  `segBox[seg(slot)]` and the cell is offset by the tile origin. Contention stays about one point
  per cell (0.2-0.6 ms at 325k today). On mass-weighted seed levels the scatter writes
  `(m·x, m·y, m, m·|p − cc|²)` (§8).

#### 6.2.2 Traversal

- The stack-based BH traversal is unchanged except for its root and cell geometry:
  - root = `(rootLevel_s, ox >> rootLevel_s, oy >> rootLevel_s)` with `rootLevel_s = log2 G_s`;
  - children at `(2cx+{0,1}, 2cy+{0,1})` stay inside the tile automatically;
  - cell size at level ℓ is `boxSide_s / (G_s >> ℓ)`;
  - the level-0 cell centre is `lo_s + ((cx − ox) + 0.5) / G_s · boxSide_s`. For the flat tile,
    ox = 0, so this is the same expression as today. It keeps the #251 single-occupant variance
    cancelling, up to compiler rounding (§9).
- **Softening per segment**: ε comes from `segParam.z`.
  - Flat keeps today's absolute `1e-2` on both the pyramid and the exact path.
  - Nested segments are solved in a unit-disc frame, and the CPU reference softens its two paths
    differently. `EXACT` segments (k ≤ 32) use **1e-9**, as `repel()`'s exact loop adds `1e-9` to
    d² in unit coordinates. Tiled segments use **1e-8**: the CPU runs BH in a ×1000 frame
    (`BH_SCALE`) with the absolute 1e-2, which is 1e-8 in unit coordinates.
- `STACK_MAX = 4·(Lmax + 1) = 44` for `Lmax = 10`.

#### 6.2.3 Level storage and the luma v9 mip question

- **Can luma.gl 9.3.3 render into one mip level?** Yes. `createFramebuffer({ colorAttachments:
  [texture.createView({ baseMipLevel: ℓ, mipLevelCount: 1 })] })` attaches that level
  (`WEBGLFramebuffer._attachTextureView` passes `baseMipLevel` to `framebufferTexture2D`). This was
  checked in the installed source.
- **But the reduce pass must read level ℓ and write level ℓ+1 of the same texture.**
  - WebGL2 treats this as a **feedback loop** unless the sampled texture's
    `TEXTURE_BASE_LEVEL`/`TEXTURE_MAX_LEVEL` exclude the attached level. This reading of the WebGL2
    feedback-loop rule is not yet verified on a device; the first test of gpu-tile-pyramid is a
    20-line probe that settles it.
  - luma does not expose base/max level: `WEBGLTextureView` has no GL object, and sampler objects do
    not carry base/max level.
  - A single mip texture would therefore need raw `texParameteri` calls per reduce pass through the
    `WebGLDevice` seam, fighting luma's state tracking.
- **Decision (recommended): packed levels in three textures, pure luma.**
  - `L0` (`A × H`, `rgba32f`) holds level 0. It is the only level whose w channel, the second
    moment (#251), is read.
  - `Podd` holds levels 1, 3, 5, …: level 1 at (0,0), the rest stacked in a column to its right.
  - `Peven` holds levels 2, 4, …, packed the same way.
  - A reduce pass samples one texture and renders into another, so there is never a feedback loop.
    Writes target the level's rectangle through the render-pass `viewport`, with
    `clearColor: false` (§6 clear rule). The shader subtracts the rectangle offset from
    `gl_FragCoord`, and per-level offsets are a uniform array.
  - `fetchCell(level, cx, cy)` becomes a 3-way branch instead of today's 11-way unrolled switch.
  - The largest dimension is `A`, the same device limit as today's single level.
  - At G = 1024 this uses 23.3 MB instead of 22.4 MB (+4%, §10.2).
  - Alternative: one mip texture plus raw-GL base/max clamps. It saves the 4% but adds a raw-GL
    seam. Maintainer decision (§15, Q2).

#### 6.2.4 Exact loop

For a segment with `count ≤ exactMax`, loop `j ∈ [start, start+count)`, skip self, and use the same
kernel. This is `repulsion-allpairs.ts` with bounds from `segInfo`. Flat with N ≤ 4096 loops
`j = 0 … N−1` in the same order as today; the result equals today within the compiler-rounding
tolerance of §9 (the loop bounds now come from a texture, which can change how ANGLE compiles it).

#### 6.2.5 Texture-unit budget

The WebGL2 minimum is 16 units. Today the pyramid pass binds 13 (u_pos, u_box, 11 levels).

| Pass | Samplers (flat → seed levels → nested) |
|---|---|
| Tree level 1 / level ℓ | 2 (pos, vel) / 2 |
| Range query | 7 (tree A/B × 2 chains, segInfo, pos, vel for level-0 heads) |
| Stop latch | 2 (segStats, latch state) |
| Tile scatter | 3 → 4 (+ mass) → 4 (pos, segBox, segInfo, + slotSeg) |
| Pyramid reduce | 1 |
| Repulsion | 7 → 7 → 9 (pos, segInfo, segBox, segParam, L0, Podd, Peven, + slotSeg, radius) |
| Springs (rows / hub chunks / partial gather) | rows 3 → 5 (+ weights, mass) → 6 (+ weights, v*, radius) / chunks 3 → 4 / gather 2 |
| Centering | 3 → 4 (+ mass) → 5 (pos, segStats, segParam, + slotSeg, segAnchor) |
| Integrate | 6 (pos, vel, force, pinned, stab, latch) → 6 → 6 (pos, v*, springs, pinned, slotSeg, segParam) |
| Readback pack | 1 → 1 → 2 (pos, + slotOfNode) |
| Collision (stage 2) | ~11 (pos, radius, slotSeg, segInfo, segBox, occupancy ×4, count, large list) |

Every pass stays at or below 11. A texture-unit capability check is not needed (§6.6).

### 6.3 Chunked CSR spring rows

- **Rows with ≤ C = 256 entries** (all but a few hundred nodes on web graphs) keep today's gather,
  one fragment per slot, in the same loop order. The 4096 cap is removed. A slot whose row is longer
  than C skips the row loop.
- **Rows with > C entries** are split into chunks of ≤ C entries. The CPU builds `hubChunks`.
  1. The **chunk pass** is its **own render pass into `hubPartials`**, encoded before the `force`
     pass (it targets a different framebuffer and its output is read by the gather). One fragment per
     chunk sums `pos[j] − pos[i]` (times the weight, if any), with no blend.
  2. The **partial gather**, inside the `force` pass: the hub's own row fragment sums its chunks'
     partials. It finds its `(firstChunk, chunkCount)` by binary search in a small `hubRows` table
     sorted by slot (H ≤ a few thousand entries, so ~12 fetches, and only on the rare hub branch).
     There is no per-slot texture, so flat pays nothing. The partials are gathered, not blended, so
     the result is deterministic and needs no extra ADD pass.
- **Effect.** The 13,507 half-edges dropped today come back. Action-reaction holds again (the
  stabilizer already uses the full degree), and hub springs match the CPU path. For hubs with
  4096 < degree, this is the **only intended numeric change** on the flat path (§9).
- **Cost.** The chunk count is `Σ_{deg>256} ceil(deg/256)`, a few thousand at most on web graphs, so
  the pass costs < 0.1 ms (estimate). It also fixes the load imbalance of a fragment looping 10k times.

### 6.4 One solver across multilevel levels, and the structural seed for plain graphs

**Today.** `gpuMultilevelSeed` constructs a new `GpuForceLayout` per solved level (every texture,
FBO and `Model`), plus a bare texture per prolongate-only level. It reads positions back
**synchronously** after every level (`extractLeaves`). It only runs when a module tree exists
(`canModuleSeed`), so plain graphs get the viewport disc.

**Design.**
- **Capacity + `setLevel`.** The solver is built once for `capacity` = the finest level's slot count
  and CSR size.
  - `setLevel({ count, csr, weights, mass, stab, segments })` sub-uploads the level's CSR,
    weights, mass and stabilizer into the capacity textures (`writeData` sub-rectangles) and updates
    uniforms (`u_count`, `u_weighted`, `u_maxStep`). The atlas width W stays fixed.
  - **Per-level state is reset.** `ProlongatePass` writes `vel = 0` by MRT into the velocity side
    that becomes `vel[read]` (the other side is overwritten in full by the next integrate), so no
    fine slot inherits a coarse slot's velocity (coarse slot s and fine slot s are unrelated nodes).
    The `pinned` mask is all-zero on coarse levels. The stop-latch state resets to "no sample"
    (§6.5.5).
  - **Pyramid per level without the tile atlas.** A level's grid has side `chooseGrid(count)` and
    lives in the top-left corner of today's capacity-sized per-level textures. The scatter takes the
    grid side as a uniform, the reduce passes write only the level's sub-rectangles
    (`clearColor: false`), and the traversal starts at a **root-level uniform** instead of the
    compile-time top. This needs nothing from gpu-tile-pyramid; once that lands, a level is simply a
    tile at origin (0,0) inside `L0/Podd/Peven`.
  - Changing level allocates nothing (spy-tested, §13).
- **Prolongation** (`ProlongatePass`) reads the coarser level from the read-side position texture
  and writes the finer seed into the write side. Then the ping-pong swaps, so there is no feedback
  loop. Both levels share W, so a parent slot maps to a texel with one width. The child offsets are
  the shared schedule's phyllotaxis rule (§8); they depend only on static data (child order, mass,
  spacing), so the worker precomputes them per level and `setLevel` uploads them into the `force`
  texture, which is free between levels (the first tick clears it). No extra texture.
- **No per-level readback.** A leaf that ends at depth d (ragged module trees, #180) is written
  straight into a transient node-order `leafSeed` texture (`rg32f`, N texels) by a `point-list`
  pass with no blend (each leaf once). The finest level seeds from `leafSeed`, which is then freed.
  The #180 semantics are preserved exactly: a terminal leaf is placed with its parent and never
  subdivided.
- **Seed work runs inside the streamed, budgeted loop** (§6.5) as work items `(level, ticks)`. A
  coarse level solve therefore never queues hundreds of ms of GPU work in front of the renderer.
  - **Frames.** The first frame is the **seed frame** (tick 0), emitted once the finest level is
    seeded, as the worker path does. Until then the CPU disc that `network.ts` pre-seeds stays on
    screen. With §8 both are at the equilibrium scale, so the seed frame rearranges the layout at
    the same scale; it does not zoom. That step is documented, not animated.
  - **Pins during the seed.** `pin`/`unpin` carry node ids, but coarse levels have coarse slots. The
    handle queues them and applies them when the finest level becomes active. `stop()` cancels the
    pending seed items and deletes their fences.
  - **`iterations: 0`** runs the seed items, emits the seed frame, and settles.
- **Structural seed for plain graphs.**
  - The coarsening LOD tree (heavy-edge matching) carries `parent[]` and super-edges and passes
    `canModuleSeed`. On web-NotreDame it has 13 levels (325,729 → 59,100 → 23,362 → 9,627 → … → 5
    roots).
  - **Measured, with today's unweighted GPU seed rescaled to the equilibrium radius after the fact**:
    at tick 100 it reaches the quality the disc seed reaches at tick 300 (mean edge 454 vs 585). The
    GPU seed in this spec is the **mass-weighted** variant of §8, which lays out every level at the
    finest equilibrium scale by construction. It is expected to be at least as good, but that has
    not been measured on the GPU; gpu-ml-seed-plain re-measures it in its Performance section.
  - **Source of the tree: the layout worker** (recommended, §15 Q7). The worker already coarsens for
    the worker multilevel path. A new `MainToWorker` variant `{ type: "coarsen" }` (in
    `worker-protocol.ts`) returns the levels (counts, CSR with weights, parents, masses, prolongation
    offsets) and the LOD topology as transferables. The main thread builds the solver while the
    worker coarsens.
  - The main thread does **not** build the LOD tree (it saves 244-308 ms). How the adopted tree gets
    its geometry during streaming is §12.1 (PR 3c). Adopting it as `lodWorkerTree` is correct only
    if the worker keeps streaming geometry; otherwise `drawsWorkerTree()` freezes the aggregates at
    their first positions (`network.ts:1772`, `:2756-2763`).
- **Scale.** The seed's disc radius, per-level scale and child offsets come from the shared schedule
  (§8). Today they are viewport-scaled (`0.4·min(W,H)`, `maxStep = 4·max(W,H)`), which causes the
  tick-6 fling (bbox 186k, then 36k).
- **#312 parity.** `multilevel` is forwarded into the GPU options. The GPU honours it
  (`multilevel: false` gives the disc seed), and so does the worker fallback (PR 2a). Today the
  fallback always runs multilevel.

### 6.5 The streaming transport

#### 6.5.1 Frame loop and ordering

- **One rAF per frame, render first.** `startGpuLayout` takes a frame source from the engine, and
  the engine's render rAF drives the layout in two halves around its own draw calls:
  1. `layout.beforeRender()`: poll the budget fences and the readback fence
     (`clientWaitSync(sync, SYNC_FLUSH_COMMANDS_BIT, 0)`, the #141 lesson from
     `webgl/pick-readback.ts`); **harvest before encoding**: if the readback fence has signalled,
     `getBufferSubData` into `graph.positions`. A read that is not ready is never forced; doing it
     after encoding would make any synchronous fallback wait behind freshly queued commands. If a
     harvest landed and the repaint throttle allows (§6.5.4), `onFrame` runs and the engine's layout
     repaint happens **in this same rAF**, so harvested positions are drawn without an extra frame of
     delay (today `onFrame` schedules a second rAF, one frame later);
  2. the engine renders;
  3. `layout.afterRender()`: encode layout work items within the frame budget (§6.5.3); if a
     readback is due (throttle) and the PBO is free, issue the copy and its fence (§6.5.2); insert
     this frame's **budget fence**.

  The GPU therefore executes render → layout each frame, and a presented frame never waits behind
  that frame's layout work. When the engine does not render in a frame, the transport's own rAF runs
  both halves. Without an engine (tests, standalone use) the transport runs its own rAF.
- WebGL sync status only changes between tasks, so a fence is never observed as signalled within the
  task that inserted it. The controller therefore reasons in frames, not in ticks (§6.5.3).

#### 6.5.2 Readback

- **Format probe first.** At construction, query `IMPLEMENTATION_COLOR_READ_FORMAT/TYPE` on the
  position framebuffer. When it is `RG/FLOAT` (it is on the measured device: today's `readPixels`
  already reads `RG/FLOAT` from `rg32f`) and the permutation is the identity, the copy reads the
  position texture directly. No pack pass and no staging texture are allocated.
- **Pack pass (only when needed).** When the probe fails, or the permutation is not the identity,
  one fragment per output texel t writes node ids 2t and 2t+1 as `(x0, y0, x1, y1)` into a staging
  `rgba32f` texture of `ceil(N/2)` texels (node-id order, through `slotOfNode`).
  `EXT_color_buffer_float` guarantees `RGBA/FLOAT` from an `rgba32f` attachment. The same node-order
  texture is what the renderer will sample in #184.
- **PBO storage must be `STREAM_READ`.** luma 9.3.3 cannot create it: `WEBGLBuffer` emits only
  `STATIC_DRAW` or `DYNAMIC_DRAW` (`webgl-buffer.ts` `getWebGLUsage`, "@todo usage is not passed
  correctly"). Without a `*_READ` usage, Chrome's `getBufferSubData` cannot use its readback shadow
  copy and falls back to a synchronous round trip to the GPU process, and Firefox warns about
  pipeline stalls. So the PBOs are created **raw**, as `PickReadback` does: `gl.createBuffer()` +
  `bufferData(PIXEL_PACK_BUFFER, size, STREAM_READ)`, reached by narrowing
  `device instanceof WebGLDevice` (no cast). The copy binds the PBO and calls `readPixels` on the
  texture's cached read framebuffer (luma's `Texture.readBuffer` needs a luma `Buffer`, so it is not
  used here). The framebuffer is one that already has the texture attached (the integrate FBO that
  wrote `pos`, reached through `WEBGLFramebuffer.handle` after an `instanceof` narrowing, or the
  staging FBO), so no framebuffer is created per frame. T7 asserts
  `getBufferParameter(PIXEL_PACK_BUFFER, BUFFER_USAGE) === STREAM_READ`.
- **One PBO by default.** The repaint throttle issues a readback at most every `minFrameMs`
  (≥ 50 ms, §6.5.4), so the previous copy has almost always signalled by the time the next is due.
  If it has not, the copy is skipped for that frame. A ring of 2 is the alternative (§15, Q9). A
  48-byte stats PBO (raw, `STREAM_READ`) carries `segStats`, `segBox` and the latch state in the
  same fence.
- **Harvest.** `getBufferSubData(PIXEL_PACK_BUFFER, 0, graph.positions, 0, 2N)` straight into the
  existing positions array. **No per-frame allocation.** luma's `Buffer.readSyncWebGL` allocates a
  new `Uint8Array` per call, so the harvest uses the raw handle. Today's `readPositions` allocates
  two ~2.6 MB arrays per frame; that goes away. The fence helper is shared with `PickReadback`.
- **`settled`** resolves only after positions from a frame whose stats show the stop latch set have
  been **harvested** (or the tick cap was reached). The settle handler's
  `recomputeLODGeometry(true)` therefore sees the final positions.
- Synchronous `readPositions` stays only for tests and one-off reads, never on the streaming path. A
  spy enforces this (§13).

#### 6.5.3 GPU time budget: band slicing and the fence controller

**Why slicing.** BH repulsion is one full-screen draw: 9.6-12.4 ms at 325k and about 32-41 ms at 1M.
A whole tick is 13-17 ms and 45-55 ms. The GPU does not preempt a draw, and the layout and the
renderer share one GL context, so a frame that encodes a whole tick makes the next rendered frame
wait behind it: about 50 ms of pan/zoom latency at 1M. Counting the budget in whole ticks cannot fix
that.

**Work items.** A tick is encoded as a sequence of items:

| Item | Passes | Target | Cost at 325k / 1M (est.) |
|---|---|---|---|
| **P** (prep) | reduction tree + range query + stop latch; tile scatter + packed reduce; clear `force` (full); hub chunks → `hubPartials` (own render pass) | tree, `segStats`/`segBox`, latch, `L0`/`Podd`/`Peven`, `force`, `hubPartials` | ~1-2 ms / ~3-5 ms |
| **F_b**, b = 0 … B−1 | force pass over atlas rows `[r0_b, r1_b)` via `parameters.scissorRect`: springs (rows ≤ C, then hub gather), repulsion, centering, in that order | `force` (ADD, `clearColor: false`) | (12-15 ms) / B; (40-48 ms) / B |
| **I** (integrate) | integrate with `alpha·heat`, `maxStep`, latch pass-through; swap | `pos`/`vel` write (MRT) | < 1 ms / ~2 ms |

- Positions change only in **I**, so every band reads the same `pos[read]` and the same pyramid.
  The Jacobi semantics are unchanged.
- Bands write disjoint texels, and each texel receives its contributions in the same order (springs,
  repulsion, centering) for any B. The result is **bitwise independent of B and of frame timing**.
- The scissor restricts rasterisation only; the viewport and the slot ↔ texel mapping stay the same.

**Controller** (`gpu/frame-budget.ts`, a pure object, node-tested with fake fences and a fake clock):

- **Budget.** `budget = min(budgetMs, 0.6 × median rAF interval)`, with `budgetMs = 10` by default.
  At 60 Hz that is 10 ms; at 120 Hz it is 5 ms. Either way the layout gets at most about 60% of the
  GPU (§15, Q4).
- **Gate: up to 2 frames in flight.** At `afterRender()` of frame f, new items are encoded only if the
  budget fence of frame f−2 has signalled. If it has not, the GPU is behind: encode nothing, halve
  `k`, and hold `k` for 30 frames. Otherwise, once the hold has expired, `k` grows by 1.
- **`k` counts items**, not ticks. Each frame encodes up to `k` items, continuing the current tick
  (so a tick may span several frames).
- **Band count `B`.** It starts from a static estimate (`B = ceil(c_F · N / (budget / 2))`, with
  `c_F` calibrated per device class from the §10.1 numbers, ≈ 40 ns per node on M1 Max). It doubles
  when `k = 1` still misses the gate, and halves (down to 1) when a whole tick fits in one frame for
  30 frames. Small graphs end at `B = 1` with several ticks per frame, as today.
- **Main-thread cap.** Encoding costs about 0.2 ms per item (~0.66 ms per tick measured,
  N-independent). `k` is also capped so that measured encode time per frame stays ≤ 2 ms. At small
  N that is the binding limit, not the GPU.
- **One budget fence per frame**, always, after the frame's items and independent of readback. When
  a readback copy was issued, the budget fence after it doubles as the readback fence.
- **No timer-query path in this series.** `EXT_disjoint_timer_query_webgl2` is rarely exposed in
  Chrome, so a second controller would be a code path that almost never runs. It is a follow-up
  issue, to pick up if a non-M1 device shows the fence controller mis-sizing `k` or `B` (§16).
- Drag/cool reheat uses the same controller instead of the fixed `REHEAT_BATCH = 3`.

#### 6.5.4 Repaint throttle

A harvest is not a repaint. The throttle decouples the layout's GPU cadence from the main thread's
repaint cadence, so the solver keeps the GPU busy while the main thread repaints at the rate it can
sustain:

- `onFrame` fires only when a new harvest has landed **and** at least
  `max(minFrameMs, 2 × lastRepaintMs)` has passed since the previous `onFrame`.
  `minFrameMs` defaults to 50 ms (≤ 20 layout repaints per second). The `2 ×` term caps the main
  thread spent on layout repaints at about 50%, whatever the engine costs.
- The readback copy is issued on the same cadence (reading back more often than repainting is
  waste).
- `lastRepaintMs` is measured by the engine around its layout repaint (rebuild + LOD) and passed back
  through the frame source.
- **Measured consequence for today's engine.** The worker path's layout frame costs 51.9 ms of main
  thread with LOD on, so the throttle would allow about 10 layout repaints per second at 50% main
  thread. The GPU path without PR 3c would add `computeLODGeometry` (16-23 ms) to every one of them.
  Faster repaints need the engine-side work (#<lod-frame-waste>, #<lod-incoherent>) and PR 3c
  (§12.1). The GPU transport does not claim a user-visible fps on its own.
- `frameEvery`, when given explicitly, means "at most one `onFrame` per `frameEvery` completed
  ticks". It keeps tick-count-based tests deterministic. When omitted (the default under §8), the
  throttle alone sets the cadence.

#### 6.5.5 Convergence stop, decided per tick on the GPU (#124)

The shared rule (§8) is checked **every tick** on the CPU and the worker:
`converged = step < CONVERGED_STEP · spacing && step ≤ prevStep`, where `step` is the mean clamped
displacement of the tick just integrated. Evaluating it once per frame on lagged stats would make
the stop tick depend on frame timing (up to many ticks late, different run to run), so the final
layout would not be deterministic. The GPU therefore decides it per tick:

- **Latch pass** (1 texel, inside item P, right after the range query). At the start of tick t,
  `segStats.z / max(count, 1)` is the step of tick t−1, because `vel` stores the clamped step. The
  pass reads the latch state `(prevStep, hasSample, stopTick, flags)` from a 2-texel `rgba32f`
  ping-pong and applies the CPU rule with `thr = CONVERGED_STEP · spacing` as a uniform. On the first
  tick of a run or of a level (where the CPU constructs a fresh `ForceLayout` with `step = ∞`) it
  records no sample, so the next check compares against `prevStep = 0` and can pass only if that
  step is exactly 0, as on the CPU. `cool` and `hold` do not reset the state, as `ForceLayout.cool`
  does not.
- **Once latched**, `stopTick = t−1` is written and the integrate item becomes a pass-through
  (positions unchanged). Items already queued after the stop tick do no harm. The final state is the
  stop tick's state, whatever the frame timing.
- **Non-finite step**: the latch sets a `NONFINITE` flag and freezes integration (§6.5.6).
- The stats PBO returns the latch state with every readback. When the transport sees `stopTick`, it
  stops encoding, resolves `settled` after the harvest, and goes **idle**; the layout stays alive for
  drag reheat (#183).
- The latch can set only in the `run` and `cool` modes. In `drag` (held heat) it keeps recording
  steps but never sets, as on the worker.
- **Bbox lag, documented.** `segBox` is computed at the start of a tick, so the bbox returned with a
  frame's positions is one tick older than those positions: off by at most one step,
  `STEP_CAP · spacing` = 224 units at 325k against a layout radius of about 18,000 (≈ 1.2%). The
  handle may expose it as a live bbox for fit. Adopting it in `fitViewToLayout` is a separate
  decision. A per-frame O(N) rebuild of the tree to remove the lag is not worth it.

#### 6.5.6 Failure handling

- **Non-finite stats** (NaN or Inf in `segStats`, `segBox` or the latch): stop encoding, warn once
  with the reason, and settle. After PR 2b, restart on the worker **warm** from the last finite
  harvested positions.
- **Context or device loss.** d3gl has no handler today, and with async fences a lost context would
  leave `clientWaitSync` never signalling, `settled` never resolving, and the loop polling forever.
  The transport treats `gl.isContextLost()`, a `WAIT_FAILED` result, or a `webglcontextlost` event on
  the canvas as device loss: it cancels its rAF, drops its fences without touching GL, and settles
  with a warning (PR 3a). PR 2b adds the warm restart on the worker from the last harvested
  positions. T8 covers it with `WEBGL_lose_context`.

### 6.6 Capability checks, fallback, backend swap

- Rename and extend `device-caps.ts` into a pure `gpuLayoutSupport(caps, need)` over a typed
  `GpuCaps` record. The record is extracted from the luma `Device` in one place, so it is
  node-testable without faking a `Device`. It returns `{ ok: true }` or
  `{ ok: false, reason }`. Checks:
  1. `device.type === "webgl"`.
  2. `float32-renderable-webgl` (`EXT_color_buffer_float`): `r32f`/`rg32f`/`rgba32f` render targets
     and `RGBA/FLOAT` readback.
  3. **`texture-blend-float-webgl`** (`EXT_float_blend`). This is luma 9.3.3's WebGL name. It does
     **not** map the WebGPU name `float32-blendable` on WebGL. It is needed for ADD-blend force
     accumulation, the pyramid scatter, and the stage-2 MIN-blend occupancy. **Today this check is
     missing**: a device without the extension passes and then draws wrong forces.
  4. **Limits against the graph**: `limits.maxTextureDimension2D` must cover the position atlas side,
     the CSR atlas side (`ceil(√2E)`), the pyramid `A`, and the staging side. The WebGL2 minimum of
     2048 covers 2E ≤ 4.19M, so 1M nodes at web density (2E ≈ 9.2M, side 3032) needs a larger
     limit. Desktop GPUs report 16384.
  5. The readback format needs no check (the design falls back to `RGBA/FLOAT`, §6.5.2). The
     `RG/FLOAT` fast path is probed.
  6. Optional **functional probe**, cached per device in a `WeakMap`: two ADD-blended points into a
     2×1 `rg32f` target, read back. It catches drivers that advertise the extensions but misbehave.
     It costs about 1 ms, once.
  7. Texture units need no check: every pass uses ≤ 11 (§6.2.5) and WebGL2 guarantees 16.
- **Fallback with every option (PR 2a).** Today the GPU branch passes only `width`, `height`,
  `iterations`, `force` and `moduleTopology` to `startGpuLayout` (`network.ts:1388-1394`), never sets
  `lodStreaming`, and has no `onLODTree`. So after a fallback the worker neither honours `multilevel`
  nor streams the LOD tree, and the main thread builds it (244-308 ms) and refits it every frame. The
  fix:
  - `startGpuLayout` takes the worker branch's options: `multilevel`, `lod`, `coarsen`, and an
    `onLODTree` callback;
  - when the device promise resolves to a fallback, the engine sets `lodStreaming`, guarded by the
    same `layoutHandle` identity check the worker branch uses;
  - the engine's LOD guards (`network.ts:1958`, `:2775`, `:2819`) test the **resolved transport**
    (§12.2), not the literal `layoutOpts.backend === "worker"`;
  - one `console.warn` names the reason; the handle's `transport`/`shared` report the live worker
    transport (#297: getters, not values captured once).
- **Backend swap (#311, PR 2b). Recommended policy:**
  - A GPU layout's lifetime is tied to its device. Today `onBackendSwapped` fires **after**
    `old.backend.destroy()`, which destroys the luma device (`base-engine.ts:2290`, then `:2317`;
    `webgl-backend.ts:611` `device.destroy()`), so a teardown there would run against a
    destroyed device and lose the in-flight fences. PR 2b adds a **pre-swap hook** that stops the GPU
    layout while its device is alive; the teardown also tolerates a destroyed device (it drops
    handles without GL calls), because context loss reaches the same path.
  - If the layout was still converging, it restarts on the new backend **warm** from the last
    harvested positions, carrying the **remaining tick budget and the current heat** (`Cooling`
    state), so a swap does not rerun the full `iterations` (300 × ~700 ms at 325k on the worker). On
    Canvas/SVG that resolves to the worker. This needs a "seed from current positions" option on the
    flat worker path (the nested path has `initial`).
  - If it had settled, either an idle worker handle is created so drag reheat keeps working (it holds
    a full copy of the graph: 12 MB of edge endpoints at 325k, plus the node arrays), or the layout
    just stops. That is a memory trade-off for the maintainer (§15, Q3).

## 7. Tick pipeline (flat, stage 1 complete)

| # | Item | Pass | Target | Blend | Replaces |
|---|---|---|---|---|---|
| 1 | P | Tree level 1 (map) + levels 2…5 | tree A/B (MRT sum + box) | none | — |
| 2 | P | Range query | `segStats` + `segBox` (MRT) | none | 1-px centroid scatter (17.3 ms), 1-px bbox scatter (18.8 ms) |
| 3 | P | Stop latch (1 texel) | latch state | none | — |
| 4 | P | Tile scatter | `L0` | ADD | pyramid scatter (reads `segBox` instead of `boxTex`) |
| 5 | P | Packed reduce ×(levels − 1) | `Podd`/`Peven` rects | none | per-level textures |
| 6 | P | Clear `force` (full attachment) | `force` | — | — |
| 7 | P | Hub chunks (own render pass) | `hubPartials` | none | — |
| 8 | F_b | Force pass, rows of band b: springs (rows ≤ C, then hub gather), repulsion (tile root or exact), centering (range centroid) | `force` | ADD | attraction / repulsion / centering |
| 9 | I | Integrate (`alpha·heat`, `maxStep`, latch pass-through) | `pos`/`vel` write (MRT) | none | integrate |
| per frame | — | Budget fence; throttled readback copy (pack only if needed) → PBO; stats → PBO | PBOs | none | sync `readPixels` |

- Each render pass is followed by `device.submit()` as today.
- **The order is fixed**, and it matches today's `_tick`: springs, then repulsion, then centering.
  Float addition is not associative, so the ADD blend makes the force bits depend on pass order. The
  hub chunk pass is not part of the force pass at all: it renders into a different framebuffer and
  must finish before the gather reads it.

## 8. The shared force schedule (`fix/layout-seed-equilibrium`, #<seed-scale>)

That branch (uncommitted at the time of writing; the names below are its current API and may still
move) changes the shared physics. The GPU path adopts it and defines nothing of its own.

**What the branch implements** (`force.ts`, `coarsen.ts`, `layout-worker.ts`, `worker-protocol.ts`):

- `equilibriumSpacing(params) = √(π·repulsion/centering)` (56 with the defaults), and
  `seedPositions(graph, w, h, { force })` laying out a disc of radius `√(repulsion·N/centering)`
  (18,048 at 325k).
- `stepCap(spacing, span0) = STEP_CAP · spacing` (`STEP_CAP = 4`), or `4 · span0` for a model
  without a spacing.
- **`Cooling`**, a stateful object: `heat`, `cool(ticks, from = 1)` (geometric decay to
  `MIN_HEAT = 0.02`), `hold(heat)`, `next()` once per tick. The integrator uses `alpha · heat`.
- **Per-tick convergence**: `converged = spacing > 0 && step < CONVERGED_STEP · spacing && step ≤
  prevStep` with `CONVERGED_STEP = 0.06`; `step` = mean clamped displacement over all nodes (pinned
  nodes count as 0); `step` starts at ∞ and `prevStep` at 0.
- Reheat: `hold(DRAG_HEAT = 0.3)` while dragging, `cool(RECOOL_TICKS = 120, DRAG_HEAT)` on release,
  stopping early once converged.
- `frameEvery` is optional; omitted, the worker streams by time (about every display frame). `done`
  carries the tick the run stopped at.
- **Mass-weighted coarse levels.** `asView(level, pos, mass)` passes each supernode's **mass** (the
  number of finest nodes it stands for) and the aggregated edge weights as `springWeight`. So a
  coarse level has mass-aggregated BH repulsion, springs `attraction · w / mass` per endpoint
  (deliberately asymmetric), a mass-weighted centroid, and `stab = 1/(1 + k · deg_w / mass)`.
  Attraction is normalised by `edges / Σweight`. Prolongation places children on a golden-angle disc
  about the parent at the cumulative mass of their earlier siblings, scaled by the spacing.
- `springStabilizers` uses `params.alpha`, **not** `alpha · heat`: the stabilizer is constant across
  cooling on the CPU.

**GPU adoption:**

| Schedule item | GPU adoption |
|---|---|
| Seed (disc) | the GPU transport calls the same `seedPositions(graph, w, h, { force })` |
| Multilevel seed | the same level construction (in the worker, §6.4). Coarse levels carry `mass` and `weights`: mass-weighted scatter `(m·x, m·y, m, m·\|p − cc\|²)`, mass-weighted `segStats` centroid, weighted-degree ÷ mass `stab`, springs `w · attraction / mass_i` (uniform-branch variant, §5.4). The finest level keeps unit mass. Child offsets: the same phyllotaxis rule, precomputed per level (§6.4) |
| Step cap | uniform `u_maxStep = stepCap(spacing, span0)`, the same on every level (mass-weighted levels share the finest equilibrium scale) |
| Cooling | the transport owns a `Cooling`, calls `next()` once per integrate item, and writes `u_alpha = alpha · heat` (a uniform write). `cool`/`hold` are called on the same mode changes as the worker |
| Stabilizer | constant, from `params.alpha`, as on the CPU; re-uploaded only per level. If the shared schedule ever heat-scales it, the GPU stores the weighted degree ÷ mass in that texture and computes `1/(1 + DAMPING·u_alpha·attraction·d)` in integrate, still with no per-tick upload |
| Convergence stop | the per-tick latch of §6.5.5: the same metric (Σ clamped \|v\| / count), the same threshold, the same `step ≤ prevStep` guard, the same first-tick behaviour |
| Reheat | `hold(DRAG_HEAT)` on drag, `cool(RECOOL_TICKS, DRAG_HEAT)` on release; the latch runs in `cool` |
| Time-based frames | the throttle of §6.5.4; an explicit `frameEvery` caps `onFrame` to once per that many ticks |

**Dependencies.** That branch already edits `gpu-force-layout.ts` (`Cooling`, `alpha · heat`,
`stepCap`), `gpu-transport.ts` and `gpu-multilevel-seed.ts`, the files PRs 1, 3a and 6 refactor in
place. **Recommended: land #<seed-scale> first and rebase this series on it.** If it is late:

- PRs 1, 2a, 3a, 4 and 5 do not need it; they keep today's fixed-alpha semantics, and §9 is defined
  against the code they start from;
- PR 3b (the stop latch) and PR 6 (mass-weighted seed levels, seed scale) wait for it.

## 9. Flat equivalence contract (numerical tolerance)

GLSL ES 3.00 has no `precise`, and ANGLE's Metal/HLSL back ends may contract FMAs or reorder
operations differently once the code around an expression changes. Only exact min/max and the
run-to-run determinism of **one** compiled program are guaranteed. BH also has discontinuous
decisions (level-0 binning `floor(t·G)`, the θ-accept `cellSize² < θ²·d²`), so one ulp can move a
node to the next cell or flip an accept. The contract is therefore stated as:

| Quantity | Relation to today |
|---|---|
| `segBox` | **bitwise** (min/max are exact, same inputs) |
| Same program, same inputs, any B, any frame timing | **bitwise** (run-to-run determinism; T2, T9) |
| Centroid, `Σ\|v\|` | `\|Δ\| ≤ 2·D·ε·Σ\|term\|` against a float64 reference (§6.1) |
| Pyramid mass | per-tile totals exact at every level (integer sums in float); per-cell counts equal today's except where a binning flip moves a node (counted by the outlier statistic below) |
| Springs, any row | `\|ΔF_i\| ≤ 2·D_i·ε·attraction·Σ_j\|p_j − p_i\|` against float64, D_i = the row's add depth (≤ C + chunks) |
| Springs, rows > 4096 | **intentionally different**: the dropped entries come back (5 hubs on web-NotreDame) |
| Repulsion + total force per node, from identical positions | `r_i = \|ΔF_i\| / (\|F_i\| + F_s)` with `F_s = repulsion / spacing` (≈ 3.6 with the defaults): p99(r) ≤ 1e-4 and at most 0.1% of nodes with r > 1e-2 (BH decision flips). Starting values, calibrated in PR 1 |
| After a full run | trajectories diverge chaotically, so compare distribution metrics instead: r99, r50/rmax, mean edge length within ±2% |

- **Forces, not trajectories.** Each checked tick uploads **identical positions** to both sides and
  compares forces. Comparing positions after 10 ticks is not a contract: one BH flip moves a node by
  about 0.6 units at α = 0.2, ten times a 1e-3·spacing tolerance.
- **web-NotreDame A/B** (reported in each PR's Performance section): per-node forces from identical
  positions, old vs new, **excluding the 5 hub rows** (degree > 4096), which are reported separately.
  With identical inputs only those rows change, because neighbours already had the hub in their own
  rows. No debug degree-cap option is needed. After the run: r99 and mean edge length.
- **Existing tests.** The "pass unchanged" contract holds for **PR 1, PR 2a and PR 5** only. The
  other PRs change behaviour on purpose and list the tests they change (§14):
  - PR 3a: `gpu-reheat.browser.test.ts` (frame cadence: `frameEvery` now caps `onFrame`, batches
    follow the budget), `gpu-frame-budget-perf.browser.test.ts` (new signatures);
  - PR 3b: `gpu-convergence.browser.test.ts` and `gpu-reheat.browser.test.ts` (runs stop at
    convergence instead of the full budget);
  - PR 4: fixtures with a > 4096-degree hub (none today; T4 adds one);
  - PR 6: `gpu-multilevel-seed.browser.test.ts` (one solver, mass-weighted levels),
    `gpu-backend-integration.browser.test.ts` (plain graphs no longer get the disc seed).

## 10. Cost model

### 10.1 Per tick (M1 Max; 325k measured per pass; 1M extrapolated as ×3.07 in N, BH × log factor 1.09)

| Pass | 325k today | 325k target | 1M today (extrap.) | 1M target (extrap.) |
|---|---|---|---|---|
| 1-px centroid scatter | 17.3 | **0** | ~53 | **0** |
| 1-px bbox scatter | 18.8 | **0** | ~58 | **0** |
| Reduction tree + range query + latch | — | 0.3-0.6 (est.) | — | ~1-2 (est.) |
| Tile scatter + packed reduce | 0.7-1.1 | 0.7-1.1 | ~1.5-2.5 | ~1.5-2.5 |
| BH traversal, θ = 0.9 | 9.6-12.4 | 9.6-12.4 | ~32-41 | ~32-41 |
| Springs (rows + hub chunks) | 2.1 | ~2.2 | ~6.5 | ~6.7 |
| Centering + integrate | ~1 | ~1 | ~3 | ~3 |
| **Tick** | **44.5-51** | **~13-17** | **~155-165** | **~45-55** |

- G is capped at 1024, so at 1M the finest cells average ~1 node. BH stays in its intended regime.
- **Band slicing.** With the 10 ms budget at 60 Hz (bands sized to about half the budget), a 325k
  tick is P + ~3 bands + I, spread over about 1.5-2 frames; a 1M tick is P + ~8-10 bands + I,
  spread over about 5 frames. Slicing adds only the
  per-item encode cost and the repeated bind of the force pass state (estimated < 0.1 ms per band).
- **Tick throughput** is at most `0.6 × 1000 / tick_ms` ticks per second (the budget's GPU share):
  about 35-45 ticks/s at 325k and about 11-13 ticks/s at 1M, **if** the render fits in the rest of
  the frame. The render cost of 325k nodes and 1.5M edges with LOD off has not been measured;
  T7 reports the real ticks/s under rendering.
- Morton ordering (a follow-up) would take BH from about 9.6 to 7.8 ms at 325k.

### 10.2 GPU memory per texture (bytes = texels × bytes per texel)

| Texture | 325k (W = 571) | 1M (W = 1000, 2E ≈ 9.2M) | Change |
|---|---|---|---|
| `pos` ×2, `vel` ×2 (`rg32f`) | 10.43 MB | 32.0 MB | = |
| `force` (`rg32f`) | 2.61 MB | 8.0 MB | = |
| `pinned` (`r8`) / `stab` (`r32f`) | 0.33 / 1.30 MB | 1.0 / 4.0 MB | = |
| CSR `offsets` + `neighbors` (`r32ui`, 1731² / 3032²) | 1.30 + 11.99 MB | 4.0 + 36.8 MB | = |
| `hubChunks` + `hubPartials` | < 0.1 MB | < 0.3 MB | + |
| Pyramid, today 11 textures | 22.37 MB | 22.37 MB | removed (PR 5) |
| Pyramid `L0` 1024² + `Podd` 640×512 + `Peven` 320×256 (`rgba32f`) | 16.78 + 5.24 + 1.31 = **23.33 MB** | 23.33 MB | **+0.96 MB** (PR 5) |
| Reduction tree, 2 chains (`rgba32f`) | **0.70 MB** | **2.13 MB** | + (PR 1) |
| Stop latch (2 texels) | 32 B | 32 B | + (PR 3b) |
| 1×1 `sumTex`, `boxTex` | 32 B | 32 B | removed |
| Readback staging (`rgba32f`, N/2 texels) | 0 on the RG fast path (2.61 MB otherwise) | 0 (8.0 MB otherwise) | + only if the probe fails or the permutation is not the identity |
| PBO (1 by default, §15 Q9) | **2.61 MB** | **8.0 MB** | + (PR 3a) |
| Multilevel seed only: `mass` + `weights` (largest coarse level) + transient `leafSeed` | 0.24 MB + 2E₁·4 B + 2.61 MB | ~0.8 MB + 2E₁·4 B + 8.0 MB | + during the seed (PR 6); 2E₁ is measured in PR 6 |
| **Total, flat** | **~50.3 → ~55 MB** | **~108 → ~119 MB** | |

- **CPU memory.** The readback lands in the existing `graph.positions`, so no new CPU buffer is
  added. Today's two 2.6 MB allocations **per frame** go away.
- **Multilevel.** Peak memory falls: one capacity-sized solver plus the seed-only textures replaces
  a second concurrent `GpuForceLayout` per level.
- **Memory limits.** The largest single texture is the CSR (2E texels, 4 B). On a device with
  `maxTextureDimension2D` = 2048 the GPU path refuses graphs with 2E > 4.19M and falls back (§6.6),
  instead of failing at `createTexture`.

### 10.3 Per streamed frame (user-visible)

| | Today | Target | How it is checked |
|---|---|---|---|
| Transport main thread per rAF (harvest + encode) | ~230 ms block (sync fence) | ≤ ~3 ms (encode ≤ 2 ms + harvest memcpy of 2.6 MB ≤ ~1-2 ms) | T7, asserted |
| Pan/zoom GPU latency added by the layout | a whole 5-tick batch (~230 ms) | ≤ the budget (10 ms at 60 Hz) | T7 throughput leg |
| Layout repaints per second, 325k, LOD off | ~4 | min(20, 1000 / (2 × repaint ms)); repaint ms at 325k / 1.5M edges with LOD off **to be measured** in PR 3a | T7 report |
| Layout repaints per second, 325k, LOD on | ~4 (GPU) / 1 per 3-4 s (worker) | worker-path repaint is 51.9 ms today → ~10 per second at 50% main thread; better only with #<lod-frame-waste>, #<lod-incoherent> and PR 3c | T7 LOD leg vs the worker baseline |
| Tick throughput, 325k | 300 ticks in 13.4 s (~22/s, UI frozen) | ~35-45 ticks/s (est.; measured under rendering) | T7 ticks/s |
| Time to converge, 325k | 13.4 s (300 fixed ticks) | ~2.5-5 s (100-150 ticks ÷ measured ticks/s; needs §8 and PR 3b) | T7 report |
| Time to converge, 1M | ~48 s + a frozen UI (extrap.) | ~12 s at the 10 ms budget (est.) | 1M bench |
| Construction (once per `layout()`) | 572 ms main-thread task | ~0.5 s main-thread task; ~6 more programs are compiled synchronously. PR 1 measures the split (compile, CSR, uploads); async compile stays a follow-up (§16) | Performance sections |

## 11. Stage 2: how the rest plugs in

### 11.1 Nested layout (#333): one batched solve over all depths

**The key insight** (from the nested investigation). A module's local solve reads only static data:
child weights, sibling links, the spiral seed or warm centroids. The parent's disc is read only when
the result is mapped into it. So **every module at every depth solves at once**: one segmented solve
over all tree nodes except the root, with segment = parent module. That is T ticks in total, not
D × T. #333 currently proposes one solve per depth; this replaces it. Then come D cheap composition
gathers.

- **Slots.** Every non-root tree node is a child in exactly one segment. Segments are sorted by
  (parent depth, parent id), and within a segment slots follow the children CSR. k = 1 segments are
  `FROZEN`: local (0,0), no forces, composed as centre = parent and R = 0.9 R_parent, as on the CPU.
- **Per-slot attributes.** `radius = √(packing · max(w_i, floor) / Σw)` in the unit disc (the CPU
  formula). No stabilizer (`stab ≡ 1`). Per segment: `REPULSION = 0.04/k`, `GRAVITY = 0.08` toward
  the local origin, `alpha0` (1 cold, `WARM_ALPHA` warm), and ε (1e-9 exact, 1e-8 tiled, §6.2.2).
- **Integration constants (matching `nested-layout.ts`).** The velocity multiplier is **0.6**
  (`v · (1 − DECAY)` with `DECAY = 0.4`; the flat path's `DAMPING = 0.9` is a multiplier too, so the
  uniform carries 0.6, not 0.4). **No `maxStep` clamp** (the uniform is disabled). **No stop rule**:
  a fixed `T = iterations` with `alpha` decaying to 0.001, as on the CPU.
- **Tick** (two phases, switched by a uniform at `organise = ceil(0.6 T)`):
  - *repel* phase: a first pass writes a scratch velocity `v* = v + repulsion + gravity` (tile or
    exact repulsion); the spring pass then reads the **predictor `x + v*`**, as the CPU's springs do
    (`nested-layout.ts:452-475` read `x + v` after repulsion and gravity were added);
  - *collide* phase: rest-length springs `(ra + rb) · PAD` on the same predictor, then collision.
  - Integrate: `v' = (v* + springs) · 0.6`, `x' = x + v'`, then collision in the collide phase.
  - The remaining difference is Jacobi vs Gauss-Seidel: the CPU applies links and collision pairs
    one at a time. Q6 covers only that.
  - Links are the CPU `sparsifyLinks` output with weights (`weights` texture).
- **Collision: a K-occupant grid, complete by construction.** The CPU grid (`collide()`) uses
  `cell = 2 · maxR · PAD` with unbounded linked lists, so it finds every contact pair. The GPU grid
  must too:
  - The cell is sized from the **9th-largest** radius in the segment, `cell = 2 · r₉ · PAD`. A slot
    is **large** when `radius > cell / (2 · PAD)` (i.e. larger than r₉), so each segment has at most
    8 large slots by construction. Two non-large discs need `(ri + rj) · PAD ≤ cell` to touch, so
    their centres are at most one cell apart and the 3×3 gather finds them.
  - Every member tests the segment's large list exactly, and each large slot gathers over its whole
    segment (at most 8 such fragments per segment; their O(k) loop is a measured risk in gpu-nested).
  - **Occupancy is counted.** An ADD-blend pass writes the per-cell count. Pass k of the K = 4
    occupancy passes is a `point-list` MIN-blend scatter into its own `r32f` texture that writes the
    slot id (exact below 2²⁴) only when the id is greater than the value in occupancy texture k−1 of
    that cell. When a cell's count exceeds K, more rounds of MIN passes run, up to the segment's
    maximum count or a cap of 16. Beyond the cap the segment is flagged, and gpu-nested chooses
    between a radius-class grid and the exact loop. Heavy-tailed radii make this the normal case in
    the compact phase: with the radius floor `total/(50k)` the ratio reaches `√(50k)` (≈ 224 at
    k = 1000).
  - **Symmetric pairs.** The 3×3 neighbourhood relation is symmetric, and with complete occupancy
    both sides see every pair. Each side computes the same pair term, so the Jacobi pushes are
    antisymmetric and conserve momentum. Under-relaxation is 0.5.
  - **Coincident discs.** The CPU bug (below) is fixed first. The GPU rule is: for `d² = 0`,
    `u = (cos(i+j), sin(i+j))` oriented from `min(slot)` to `max(slot)`, so both sides push apart,
    with displacement magnitude `min = (ri + rj) · PAD` split by the size ratio. For `d² > 0` the
    push is `(min − d)`, split the same way.
  - Segments with k ≤ 32 use the exact loop.
- **CPU bug found in review.** `collide().resolve` flings exactly coincident discs apart: for
  `d² = 0` it sets `d = 1e-9` and `push = (min − d)/d ≈ min · 1e9`, then multiplies by a *unit*
  vector. Two coincident discs of radius 0.05 end 1.15e8 apart; the composition extent explodes and
  `scale_p` collapses every sibling to a point. The fix (displacement magnitude = `min` when
  `d² = 0`) lands as its own patch PR before gpu-nested (key #<nested-coincident-fix>, §16).
- **Slot → texel mapping (a measured prerequisite of gpu-nested).** Row-major slots in an atlas
  571-1000+ texels wide put W-strided rows in one 2×2 quad or SIMD group, so a group mixes slots of
  different segments with different paths (exact loop, tile walks of different depths, K-occupant
  collision). gpu-nested measures row-major against an 8×8-blocked mapping (one function, §5.1, plus
  the pack pass) on the 336k-slot tree before committing. The cost estimate below carries a
  divergence factor until then.
- **Composition** (after the solve, and on every streamed frame; D passes).
  - Per segment p, run the range reductions in two map variants:
    - `m_p = Σ rad²·x / Σ rad²`;
    - then `extent_p = max(|x − m_p| + rad)` and `scale_p = 0.92 · R_p / extent_p`.
  - Pass d writes every slot whose parent sits at depth d−1:
    `C_c = C_p + (x_c − m_p) · scale_p` and `R_c = rad_c · scale_p`. The parent's
    `(C_p, R_p)` is read from `world[ownerSlot(p)]`, where `ownerSlot` is in `segInfo`.
  - `world` (`rgba32f`) ping-pongs per pass: each pass copies the untouched slots across, which
    avoids a read/write feedback loop.
  - Then the pack pass (with `slotOfNode`) produces the leaves in node order.
  - **Boundary discs (#329).** The engine records `onBoundaries` into `nestedDiscs`, which feed
    `lodDiscs()` and the Navigator's `MODULE_BOUNDARY` rings. A per-module pack pass writes each
    module's `(dx, dy, r)` from `world` into a small PBO (M modules × 12 B), read back with the same
    cadence as the worker path's `onBoundaries`, and delivered as `BoundaryDiscs`.
- **Warm start (#328).** The CPU `warmStart` precompute (O(tree)) supplies the initial local
  positions and `alpha0 = WARM_ALPHA`. `placeOver` runs as **two** range passes over the packed
  node-order leaves, as the CPU does in float64: first the mean over **known** leaves, then
  `Σ|x − m|²` over known leaves. The `known` mask is applied in the level-0 map (an unknown leaf
  contributes the identity). A one-pass `E[x²] − E[x]²` in float32 is rejected: its relative error is
  about `75·ε·|mean|²/σ²`, so a layout 100σ from the origin would get ~4.5% scale error. One uniform
  similarity transform in the pack pass follows.
- **Streaming follows the engine's contract.** Warm or transition layouts produce **one** frame
  today (`network.ts:1508-1517`: `warm || tween` turns streaming off, the final positions go through
  `landNested` and `fitKnownBox`, and the tween eases them in). The GPU nested path honours
  `stream: false` the same way: solve through the budgeted loop (the main thread never blocks), read
  back once, `landNested`, tween. **Only cold layouts stream**, as one animation of all depths
  converging together (§15, Q5). The Navigator's `RELAYOUT` is warm with `transition: 600`, so it
  gets "~2 s solve, then the 600 ms tween" instead of today's ~30 s frozen, not a streamed animation.
- **Cost.**
  - A tick costs about what the flat tick costs at N_tree slots, minus BH depth (walks are
    ~log k_s), plus in the collide phase ≥ 5 scatter passes (count + K) and a 9K gather, times a
    **divergence factor of up to ~2×** for row-major quads that mix segments (to be measured, above).
  - Estimate: ~10-40 ms per tick at 336k slots, so T = 100 ticks ≈ 1-4 s of GPU time, spread over
    frames by the budget. The CPU takes 25.9 s cold and 30.1 s warm (measured on a synthetic
    325,729-leaf tree).
  - A 1M-leaf tree should take ≲ 5-10 s (#333 acceptance: ≲ 5 s; the divergence measurement decides).
  - CPU prep (sparsify, tile packing, permutation) is O(tree + links · log links) and runs in the
    worker.
- **Tile memory.** `Σ G_s² ≤ ~4·N_tree`, so at 336k `A = 2048 × H ≤ 1024`: L0 ≤ 33.5 MB and the
  packed levels ≤ ~13 MB (`Podd` 1280×512 + `Peven` 640×256), about 47 MB in all. Past the device
  limit, the tile sides halve (coarser near field) as a documented degrade.
- **Routing.** `layout({ backend: "gpu" | "auto", nested })` goes to the GPU solve when supported
  (`network.ts` `startNestedLayout`, which sends worker/gpu to the worker today). Otherwise it uses
  the worker, as today. The CPU `nestedLayout` stays as the reference and the fallback.

### 11.2 Soft containment (#181)

- One repulsion segment (global).
- Leaves are in **module-DFS slot order**, so every module (at any depth) is one contiguous range,
  and ranges nest. A single range-query pass over all modules gives every module's centroid.
- The centering pass adds `γ(depth) · (centroid(parentModule) − p)`, reading `rangeOf(slot)` and
  `segAnchor`.
- There is no new primitive: this is ranges plus a pull term.

### 11.3 State layouts (#189)

- Segment = physical node.
- `"force"`: one repulsion segment, with ranges per physical node and an anchor pull toward the
  physical position (`segAnchor` from the physical layout's node-order texture).
- `"two-phase"`: segments per physical node (isolated local solves), with the physical positions
  pinned as anchors.
- #189's fixed-anchor spring is the special case of #181's computed-centroid pull.

### 11.4 GPU-resident positions (#184, later)

- The pack pass's node-order `rgba32f` texture (2 nodes per texel) becomes the render source. The
  instanced lane reads `texelFetch(pack, id >> 1)` and takes `.xy` or `.zw`. The renderer and the
  layout already share one luma device (`WebGLBackend.gpuDevice`).
- CPU consumers (LOD cut, pick, declutter, labels, fit) keep this spec's async readback, throttled.
- GPU-side LOD aggregates are range reductions over the LOD tree in DFS order, using the same
  primitive (PR 3c option B builds the first part).
- Lifetime follows the §6.6 swap policy.

## 12. Engine integration: LOD, backend resolution, and what the Navigator changes

### 12.1 LOD while the GPU streams (the gate for the Navigator switch)

**The problem.** The Navigator runs with LOD on. On the worker path the worker refits the LOD tree
geometry (cx, cy, extent for 425k tree nodes) off the main thread and streams it with the positions
(`drawsWorkerTree()` makes the main thread skip `recomputeLODGeometry`, `network.ts:1772`); frames
arrive every 3-4 s. On today's GPU path the main thread builds the tree (244-308 ms) and refits it
(`computeLODGeometry`, 16-23 ms) on **every** frame, then runs the cut, declutter and labels (2-62 ms
at the fit view, declutter spikes of 50-450 ms when zoomed). A fast GPU stream would move the refit
onto the main thread at the repaint rate. AGENTS lifecycle §5 treats that as a regression against
the worker baseline, and it may not be deferred.

**Options** (maintainer decision, §15 Q8; PR 3c builds the chosen one):

| Option | What runs where | Main thread per repaint vs the worker baseline | Cost to build | Memory |
|---|---|---|---|---|
| **A. Worker refit (recommended)** | The worker keeps the coarsening tree it built for `{ type: "coarsen" }`. At each throttled repaint the main thread posts the harvested positions (`{ type: "lod-geometry" }`, a 2.6 MB copy, ~1 ms; shared when `crossOriginIsolated`), and the worker returns the geometry (5.1 MB, transferred), as its frame message does today. Positions and geometry are applied together as one frame | the same work as the worker path's frame; one worker round trip (~20-25 ms) of extra latency | a protocol message and a worker handler around the existing `computeLODPositions` | the worker holds the graph and tree, as on the worker path (12 MB of edge endpoints plus the tree at 325k); the main thread no longer builds a tree |
| B. GPU refit | centroids as range reductions over the leaves in LOD-DFS order; extents as D bottom-up passes (13 on web-NotreDame); read back with the positions | geometry apply only | new passes, a DFS permutation, +5.1 MB PBO; it is the start of #184's GPU LOD | +5.1 MB GPU at 325k |
| C. Main-thread refit + throttle | the tree is adopted as a main-thread tree (`lodTree`, `lodWorkerTree = null`), and `recomputeLODGeometry` refits per repaint, bounded by the §6.5.4 duty cap | **+16-23 ms per repaint** (a regression by lifecycle §5, needs sign-off) | smallest | none extra |

For any option:

- **Tree adoption semantics.** With A, the tree is adopted as `lodWorkerTree`, which is correct
  because the worker keeps writing geometry every frame. With B or C it must be adopted as a
  main-thread tree or an explicit adopted-tree mode whose geometry the GPU or the main thread
  refits; adopting it as `lodWorkerTree` would freeze the aggregates at their first positions and
  make `lodSource` report `"worker"` for geometry the worker never computes.
- **The repaint throttle** (§6.5.4, PR 3a) bounds the main-thread duty cycle in all three options.
- **T7 gets a LOD leg** with the Navigator's LOD config that compares main-thread ms per repaint
  against the worker baseline on the same graph, and T8 asserts that aggregate cx/cy follow the GPU
  frames during streaming.
- The cut and declutter costs themselves (which the worker path pays per frame too) belong to
  #<lod-frame-waste> and #<lod-incoherent>. They are not self-deferred: they are reported as measured
  in each PR's Performance section, and the throttle keeps them from monopolising the main thread.

### 12.2 Backend resolution and `"auto"`

**Today.**
- `NetworkLayoutOptions.backend` is `"positions" | "force" | "worker" | "gpu"`. There is no
  `"auto"` layout backend (only the render backend has `"auto"`).
- `"gpu"` already falls back to the worker when there is no WebGL device, when the render backend is
  Canvas/SVG, or when float render targets are missing. It warns only when there is no device at all.
- `"gpu"` + `nested` always runs the CPU worker.
- `network.ts` makes **16** decisions on literal backend strings, synchronously inside `layout()`:
  lines 1301 (fit), 1305, 1308 (transition duration), 1313, 1328, 1376, 1402 (dispatch), 1508
  (nested routing), 1640, 1647, 1668 (state networks), 1958, 2775, 2819 (LOD guards), 2441, 2467
  (node-drag reheat).

**One resolved-backend notion (PR 2a lays it down; PR 2c uses it for `"auto"`).**
- A synchronous **class**: `"positions" | "force" | "streaming"`, where `"streaming"` covers
  `"worker"`, `"gpu"` and `"auto"`. The fit, drag, transition, nested and state-network decisions use
  it, because they only need to know that positions will stream in asynchronously.
- The **resolved transport**, `"worker" | "gpu"`, known once the device promise settles. The LOD
  guards and `lodStreaming` use it (this is also what fixes the fallback, §6.6).
- Without this, `"auto"` would silently break: fit disabled (1301), drag reheat reduced to
  translate-only (2467), a duplicate main-thread LOD tree next to the worker's (1958, 2775, 2819), a
  synchronous main-thread force layout for state networks (1647), and a synchronous CPU
  `nestedLayout` for nested layouts (1508), which blocks for about 30 s on the Navigator's 325k warm
  re-cluster.

**Proposal** (a maintainer decision, §15 Q1): add `backend: "auto"` in PR 2c:
- it resolves after `whenBackendSettled()` to the GPU when `gpuLayoutSupport(caps, need)` passes for
  *this* graph, and to the worker otherwise (with the worker's own sync fallback);
- it prints **no warning** on fallback, because falling back is the expected outcome;
- `layoutTransport` reports what was resolved;
- `"gpu"` keeps meaning "I want the GPU", with a warning when it falls back;
- `"auto"` + `nested` resolves to the GPU once gpu-nested lands, and to the worker until then;
- PR 2c routes every one of the 16 checks through the resolved notion and adds a T8 test for each
  kind under `"auto"`: fit, drag reheat, state network, nested, LOD streaming;
- the default of `layout({})` does **not** change in this series. Flipping it later is a separate,
  user-visible decision.

Alternatives: (a) no new value; the app passes `"gpu"`, which falls back safely after PR 2a. PR 2c
is then dropped, and the resolved-transport part of PR 2a still ships. (b) Make `"auto"` the default
now. That changes the backend for every user, including SSR and tests.

### 12.3 Navigator changes (`src/components/NetworkView.tsx`)

- **Gate.** Switch `LAYOUT` to `"gpu"` (or `"auto"` after PR 2c) only when PRs 2a, 3a and 3c are
  released and the T7 LOD leg shows the GPU path's main-thread ms per repaint at or below the worker
  baseline. PR 6 (the structural seed) and PR 3b (the stop) make it converge faster but are not
  needed for the switch.
- `LAYOUT = { backend: "gpu" | "auto", fit: true, nested: true }`.
- `RELAYOUT.backend = "gpu" | "auto"`. It gains nothing until gpu-nested; then a warm re-cluster
  takes about 2 s plus the tween instead of about 30 s frozen (§11.1).
- Positions stream through the same seam, and `whenSettled`, drag and `fit` are unchanged. The GPU
  path does not need COOP/COEP. The render backend must be WebGL (or `"auto"`, which upgrades) for
  the GPU layout to engage.
- Optional: show `net.layoutTransport` in a status readout.
- Bump `@mapequation/d3gl` as each phase is released.

## 13. Test plan

Node tests (`packages/d3gl/src/network/gpu/__tests__/`, root vitest):

- **T0 `segments.test.ts`**:
  - tile packing: every origin is a multiple of its side, tiles are disjoint, and S = 1 gives origin
    (0,0), side `chooseGrid(N)`, `A = G`;
  - canonical cover vs brute force over random ranges, including tails, single slots, `count = 0`,
    and ranges straddling `16^ℓ` boundaries;
  - hub chunking covers every CSR entry exactly once, and no gathered row exceeds C;
  - band partition covers every atlas row exactly once for B = 1 … 8;
  - the permutation round-trips; `slotTexel`/`texelSlot` round-trip.
- **`frame-budget.test.ts`** (fence controller only):
  - with fake fences: never more than 2 frames in flight; `k ≥ 1` while running; halving and the
    30-frame hold; `B` doubles when `k = 1` still misses and halves when a tick fits;
  - the encode-time cap limits `k` with a fake clock;
  - the budget follows `min(budgetMs, 0.6 × rAF interval)` at 60 and 120 Hz;
  - a frame with no readback still inserts its budget fence.
- **`device-caps.test.ts`**:
  - `gpuLayoutSupport` over typed `GpuCaps` records: missing float blend, missing float RT, limits
    too small for the CSR, all present.
- **`stop-latch.test.ts`**: a typed CPU model of the latch against `ForceLayout.converged` on a
  sequence of steps (first tick, zero step, `step > prevStep`, NaN).

Browser tests (`pnpm --filter @mapequation/d3gl test:browser <path>`):

- **T1 reductions vs a float64 reference** (`segmented-reduce.browser.test.ts`):
  - random segment sizes {0, 1, 2, 31, 32, 33, 4097, 100k} with padded tails, and ranges straddling
    `16^ℓ` boundaries;
  - an **offset** distribution (centre 1e4, spread 1) that exercises cancellation;
  - `segBox` bitwise equal to CPU min/max;
  - centroid and `Σ|v|` within `2·D·ε·Σ|term|` (§6.1); `count = 0` yields finite zeros;
  - two runs bitwise identical (determinism).
- **T2 segment isolation** (`segment-isolation.browser.test.ts`):
  - three segments share one world region;
  - moving segment B's positions leaves segment A's `force` texels **bitwise** unchanged (repulsion
    on both the tile and exact paths, springs, centering to its own centroid); same program, same
    inputs, so bitwise is guaranteed;
  - a cross-segment CSR entry is rejected by the builder.
- **T3 tile pyramid** (`gpu-pyramid.browser.test.ts`, extended):
  - per-tile mass is conserved at every level (bitwise), and each tile root's COM matches its
    segment's `segStats` within the combined bound of both add trees;
  - writing packed level ℓ leaves levels ℓ ± 2 in the same texture bitwise unchanged (the clear
    rule, §6);
  - the feedback-loop probe that settles §6.2.3.
- **T4 CPU/GPU parity**:
  - repulsion per node vs exact all-pairs per segment within today's tolerance;
  - springs on a star with a 10,721-degree hub (web-NotreDame's maximum), in an asymmetric layout:
    each row within `2·D_i·ε·attraction·Σ_j|p_j − p_i|` of a float64 sum;
  - action-reaction: `|Σ_i F_i| ≤ c·D·ε·Σ_i|F_i|`;
  - `gpu-convergence.browser.test.ts` extended with a hub graph.
- **T5 flat equivalence** (`flat-equivalence.browser.test.ts`):
  - the S = 1 solver vs `gridPyramidReference`, a typed CPU helper in the test directory that
    implements today's tick (the grid pyramid, #251 softening, CSR, centering, integrate, in
    `Math.fround`), at N = 5k with the pyramid forced, degrees ≤ 256;
  - each checked tick feeds **identical positions** to both and compares forces with the §9
    statistic (p99 and the outlier cap), over 10 ticks of a real trajectory;
  - plus a structural assertion (S = 1 tile = today's grid);
  - the reference helper is an executable spec of the GPU algorithm, and every later phase reuses it;
  - each phase PR also reports the web-NotreDame A/B of §9 in its Performance section.
- **T6 per-frame perf guard** (AGENTS §5; `gpu-frame-budget-perf.browser.test.ts`, extended):
  - the per-tick wall-clock ceiling at `perfN(30_000, { max: 200_000 })` is kept, split as
    `c0 + c1·N` (existing);
  - **new deterministic signature: no `point-list` draw of ≥ N vertices into a 1×1 viewport** (the
    regression this series removes). A spy on `WebGL2RenderingContext.prototype.drawArrays` reads
    `gl.getParameter(VIEWPORT)`;
  - zero `createTexture`/`createFramebuffer`/`createBuffer` per tick, per band, per `setLevel`, and
    per streamed frame;
  - **B-invariance**: the same tick encoded with B = 1 and B = 4 gives bitwise-equal positions.
  - The layout solver processes every node whatever the LOD state, so the LOD on/off split applies
    to the streamed-frame guard below, not to the tick guard.
- **T7 streaming guard** (new, `gpu-stream-perf.browser.test.ts`, joins the browser perf tier by
  name):
  - drive **`network().data(g).lod(…).layout({ backend: "gpu" })`** at `PERF_BROWSER_N` through real
    rAF frames, once with LOD on (the Navigator's config) and once off, on one engine (AGENTS: never
    a second large engine in one file);
  - **transport-only** main-thread time per rAF (harvest + encode) below `perfBudget(c0 + c1·N/local)`;
    encode time per frame asserted directly (≤ 2 ms, N-independent). A reintroduced sync fence costs
    the whole GPU batch and trips it;
  - **throughput**: median rAF interval and ticks/s reported; ticks/s asserted above a floor
    relative to the GPU-only tick rate measured in the same test;
  - **LOD leg**: main-thread ms per layout repaint compared with the worker path on the same graph
    (the lifecycle §5 baseline); reported and asserted not above it by more than a stated margin;
  - spies: no `readPixels` without a bound `PIXEL_PACK_BUFFER` on the streaming path
    (`PIXEL_PACK_BUFFER_BINDING`); `BUFFER_USAGE === STREAM_READ` on every PBO; no
    `getBufferSubData` before its fence has signalled; within each frame, the harvest happens
    before any encode; no allocation per frame;
  - `settled` resolves only after the final positions have been harvested;
  - **portability**: one-off T7 runs on Playwright's `firefox` and `webkit` projects before
    presenting "≤ 3 ms" as portable (Firefox's remote WebGL makes `getBufferSubData` a synchronous
    IPC; WebKit's fence/PBO behaviour is unmeasured). Results go into PR 3a's Performance section.
    GPU-process stalls do not show in main-thread time, which is why the throughput leg exists.
- **T8 engine integration** (`gpu-backend-integration.browser.test.ts`, extended):
  - fallback when float blend is disabled (luma `disabledFeatures`): reason logged, worker run,
    `multilevel` honoured, and **with LOD on**: `lodSource === "worker"` and no main-thread tree built;
  - `multilevel: false` gives a cold start on both the GPU and the fallback (#312);
  - a WebGL → Canvas swap stops the GPU layout through the pre-swap hook, the warm restart carries
    the remaining ticks and heat, and a later drag still reflows (#311);
  - context loss via `WEBGL_lose_context` mid-run: `settled` resolves, the loop stops, a warning is
    logged (and after PR 2b, the worker continues warm);
  - `layoutTransport` reflects the live transport after a fallback (#297);
  - aggregate cx/cy follow the GPU frames during streaming (PR 3c);
  - under `"auto"` (PR 2c): fit, drag reheat, state network, nested and LOD streaming each behave
    as under `"worker"`/`"gpu"`.
- **T9 determinism and stop** (`gpu-stop.browser.test.ts`, PR 3b):
  - on a small seeded graph, the GPU stop tick equals the worker's ±1;
  - two runs under randomised fake-fence timing (different `k` and `B` per frame) give bitwise-equal
    final positions;
  - non-finite injection sets the flag, stops, and settles.
- **T10 multilevel seed** (PR 6): after `setLevel`, `vel` is zero in `[0, count)`; pins issued
  during the seed are applied on the finest level; `stop()` during the seed deletes its fences;
  `iterations: 0` settles after the seed frame.
- **Stage 2**:
  - the `nested-layout.test.ts` invariants run on GPU output (child discs inside parents, no sibling
    overlap within the PAD tolerance, linked siblings closer, determinism on one device, warm-start
    invariants), with a documented tolerance against the CPU reference on the Navigator's example map;
  - a dense pack with heavy-tailed radii: no overlap beyond PAD, and `Σ displacement ≈ 0` per
    segment (momentum);
  - a coincident pair separates by `min` (CPU and GPU);
  - boundary discs match the CPU's `BoundaryDiscs`; a warm layout produces one frame;
  - a 1M-leaf nested timing bench.

**Coverage map.** Add rows to the AGENTS.md perf-guard coverage map for T6's new signatures and for
T7 (both LOD legs). PR 1 also adds one durable gotcha to AGENTS.md: *never scatter N points into
one texel. Blend serialises it (17-19 ms at 325k); reduce with a gather tree.* PR 3a adds a second:
*luma `Buffer`s cannot be `STREAM_READ`; create readback PBOs raw.*

## 14. Phased PR plan

Each row is one PR and one issue key; each ships on its own. Keys are resolved to issue numbers when
the issues are filed (sub-issues of #333 unless noted). Revision 2 keeps the original keys and adds
`gpu-swap-policy`, `gpu-auto-backend`, `gpu-convergence-stop`, `gpu-lod-stream` and
`nested-coincident-fix`.

| # | Key | Scope | Depends on | User-visible outcome | Perf entry (before → after) | Existing tests changed on purpose |
|---|---|---|---|---|---|---|
| 1 | **gpu-reductions** | segment table (S = 1), 16-ary reduction tree + range query (MRT, pairwise fragment sums), centering from `segStats`, pyramid box from `segBox`; delete `CentroidReducePass` + the bbox scatter; shared pass helper with the explicit clear; construction-time split measured; T0/T1/T5/T6 | — | 325k tick 45-51 → ~13-17 ms; 1M ~155 → ~50 ms | per tick −2 serialized O(N) point blends (N = all layout nodes), +O(N/15) gathers; +0.7 MB | none |
| 2a | **gpu-float-blend** | `gpuLayoutSupport` (float RT, `texture-blend-float-webgl`, limits, read-format probe, functional probe); fallback with every option (`multilevel`, `lod`, `coarsen`, `onLODTree`, `lodStreaming`); the resolved-backend class + transport and the LOD guards keyed on it; #297 live transport; T8 fallback legs | — | no silent wrong-force layouts on devices without float blend; a fallback keeps the worker's LOD streaming | no per-frame change (checks once per `layout()`); removes the main-thread tree build + per-frame refit after a fallback | none |
| 2b | **gpu-swap-policy** | pre-swap hook; destroyed-device-tolerant teardown; warm restart with remaining ticks + heat; flat worker warm-start option; context-loss restart; idle worker or stop-only (Q3); T8 swap + context-loss legs | 2a, 3a | backend swaps and lost contexts keep the layout going | none per frame; idle worker memory if Q3 picks it | none |
| 2c | **gpu-auto-backend** | `backend: "auto"` (if Q1 adopts it): route all 16 checks through the resolved notion; T8 `"auto"` legs | 2a | apps can ask for "GPU when it works" without warnings | none | none |
| 3a | **gpu-async-readback** | frame loop driven by the engine (render → layout); work items + band slicing; fence controller (no timer path); raw `STREAM_READ` PBO, format probe, pack only when needed; harvest before encode; repaint throttle; `settled` after harvest; NaN and context-loss detection; T6 additions, T7 | 1 (the stats readback; the PBO/budget part alone would not need it) | main thread ~230 → ≤ 3 ms per rAF; pan/zoom never waits behind a tick; layout repaints at the throttled rate | +2.6 MB GPU at 325k (+8 MB at 1M); −2 × 2.6 MB CPU allocations per frame; layout repaint rate ≤ 20/s and ≤ 50% main thread | `gpu-reheat`, `gpu-frame-budget-perf` |
| 3b | **gpu-convergence-stop** | per-tick GPU stop latch; `Cooling` in the transport; reheat mapping; T9 | 1, 3a, #<seed-scale> | runs stop at convergence (#124 GPU part) | fewer ticks per run (~100-150 instead of 300 at 325k); +32 B | `gpu-convergence`, `gpu-reheat` |
| 3c | **gpu-lod-stream** | `{ type: "coarsen" }` protocol; LOD geometry off the main thread per Q8 (A: `{ type: "lod-geometry" }` worker refit); correct tree adoption; T7 LOD leg vs the worker baseline, T8 aggregate test | 2a (resolved transport), 3a | the GPU path with LOD on costs the main thread no more per repaint than the worker path | main thread per repaint: −16-23 ms `computeLODGeometry` vs today's GPU path; −244-308 ms tree build once | none |
| 4 | **gpu-csr-chunk** | rows ≤ 256 gather unchanged, hub chunk render pass + partial gather, `weights` hook, cap removed; T4 | — | hub springs correct (13.5k half-edges restored) | +< 0.1 ms, +< 0.1 MB | fixtures with a > 4096 hub (none today) |
| 5 | **gpu-tile-pyramid** | tile packing, `L0`/`Podd`/`Peven` packed levels (3 samplers), tile-root traversal, softening per segment, segmented exact loop (`exactMax` option); T2/T3 | 1 | none on flat (equal within §9); unlocks segments | +0.96 MB; same pass count | none |
| 6 | **gpu-ml-seed-plain** | capacity + `setLevel` (one solver, root-level uniform in the per-level textures), per-level state reset, mass-weighted coarse levels, `leafSeed` gather, seed work items in the budgeted loop, queued pins, seed frame, `multilevel` honoured (#312); T10 | 1, 3a, 3c (tree from the worker), #<seed-scale> | plain graphs converge in fewer ticks (re-measured with the mass-weighted seed); no main-thread tree build | peak memory ↓ (no second solver per level); seed-only textures (§10.2); seed levels spread across frames | `gpu-multilevel-seed`, `gpu-backend-integration` |
| 7 | **gpu-nested** | nested batched solve (segments = parents), integration constants of §11.1, complete K-occupant collision, composition passes, boundary discs, warm start + two-pass `placeOver`, `stream: false` for warm/tween, slot-mapping measurement, routing `gpu`/`auto` + `nested`; stage-2 tests | 1, 3a, 4, 5, #<nested-coincident-fix> | 1M-leaf nested ≲ 5-10 s (CPU ~60 s); 325k warm re-cluster ~30 s frozen → ~2 s + tween | new per-tick collision passes (collide phase only); tile atlas ≤ ~47 MB at 336k slots | nested tests gain GPU legs |

**Recommended order.** Land #<seed-scale> first. Then, for the flat consumer: **1 → 3a → 3c → 6**,
with 2a (before 3c), 4 and (once #<seed-scale> has landed) 3b in parallel. The Navigator switch waits for 2a,
3a and 3c (§12.3). 2b and 2c are independent. Nested: **5 → 7**, after #<nested-coincident-fix>.

Why the dependencies changed in revision 2:
- 6 no longer depends on 5: `setLevel` only needs a per-level root level, which today's per-level
  textures support (§6.4).
- 7 no longer depends on 6: the nested solve is one solve at N_tree slots, not multilevel. It needs
  the reductions (1), the async loop and pack pass (3a), weighted chunked springs (4) and tiles (5).
- The stop latch (3b) is split from the transport (3a), so 3a ships without waiting for the shared
  schedule, and #124 closes only in the PR that turns the stop on.

**Issue mapping.**
- 3a fixes the Milestone-A half of #184 (the issue stays open for GPU-resident positions).
- 3b fixes the GPU part of #124. #124 closes in whichever of #<seed-scale> and 3b lands last.
- 2a fixes #297 and the fallback half of #312 (`Related to #312`); 6 closes #312.
- 2b fixes #311.
- 7 fixes #333.

Each PR carries a changeset (patch; `backend: "auto"` is an addition, patch before 1.0), a
`## Performance` section per AGENTS lifecycle §5 (using §10's numbers, re-measured, and the
construction long task), and docs updates: `website/src/content/docs/examples/network.mdx` GPU
section, the `gpu-transport.ts` header, and the `NetworkLayoutOptions` JSDoc.

## 15. Open questions (maintainer decisions)

1. **Layout `backend: "auto"`.** Add it in PR 2c (recommended), or have the app pass `"gpu"`? When,
   if ever, should it become the default for `layout({})`?
2. **Pyramid level storage.** Packed levels in 3 textures, pure luma, +4% memory (recommended), or
   one mip texture with raw-GL base/max-level clamps per reduce pass?
3. **#311 swap policy.** After a swap, continue warm on the new backend (recommended; needs a flat
   worker warm-start option). For a settled layout, create an idle worker so drag reheat keeps
   working (it holds a full copy of the graph: ~12 MB of edge endpoints plus node arrays at 325k, and
   ~37 MB of endpoints at 1M), or stop only (no memory, but a drag after the swap no longer reflows)?
4. **GPU budget.** `budgetMs = 10`, clamped to 0.6 × the rAF interval (5 ms at 120 Hz)? Should the
   budget drop further while the user pans/zooms, or rise when nothing has been touched for a while
   (an idle boost would cut the 1M convergence from ~12 s towards ~8 s, at the cost of up to a
   tick's latency on the first gesture)? And `minFrameMs = 50` for the repaint throttle?
5. **Nested streaming.** For cold layouts, one animation of all depths converging together (natural
   for the batched solve), or keep per-depth frames? Warm/transition layouts stay one frame either
   way (§11.1).
6. **Nested parity tolerance.** How far may the GPU (Jacobi springs and collision) be from the CPU
   (Gauss-Seidel) beyond the invariants? The integration constants themselves now match (§11.1).
7. **Coarsening-tree source for the GPU seed.** The worker (recommended, shared with LOD) or the main
   thread (a ~0.3 s block)? Also: the per-pass timings exist only for M1 Max / ANGLE Metal.
   Re-measure on at least one Intel/AMD/NVIDIA machine before tuning `budgetMs`, `c_F` or `exactMax`.
8. **LOD geometry while the GPU streams (§12.1).** A: the worker refits the adopted tree
   (recommended; same main-thread cost as the worker path, one round trip of latency). B: the GPU
   refits with range reductions (+5.1 MB GPU at 325k; more code; the start of #184's GPU LOD). C:
   the main thread refits per repaint under the throttle (+16-23 ms per repaint, a regression
   against the worker baseline that needs your sign-off).
9. **Readback memory** (a performance-motivated memory trade-off, so it needs a decision):

   | Option | GPU memory 325k / 1M | Behaviour |
   |---|---|---|
   | Ring of 2 PBOs + staging always | 7.8 / 24 MB | the original design; readback every frame never skips |
   | Ring of 2, staging only if the RG probe fails | 5.2 / 16 MB (M1: probe passes) | same, without the pack pass on the measured device |
   | **1 PBO, staging only if the probe fails (recommended)** | **2.6 / 8 MB** | with the ≥ 50 ms throttle a copy is almost never still pending; if it is, that frame skips its readback |
   | Staging always adds | +2.6 / +8 MB | only if the probe fails or the permutation is not the identity |

## 16. Follow-ups (file as issues; do not build here)

- **Sort-based solver**: Morton sort + implicit fan-out-4 LBVH with bbox and maxR. It gives exact
  near-field repulsion and exact collision in one traversal. Consider it if grid-pyramid accuracy on
  clumped graphs (#251) or K-limited collision falls short. Estimated 20-60 ms per full sort at
  1-2M, amortised over 10-20 ticks (unverified).
- **Morton/Hilbert reorder of flat slots**: measured −19% BH, −10% attraction on today's row-major
  mapping. It uses the §5.1 permutation with no API change. 2×2 quads stay spatially incoherent after
  a 1D sort with row-major texels, so a blocked texel mapping (§5.1) may add to the gain; measure
  both.
- **Merged force pass**: springs + repulsion + centering in one fragment. It would drop the `force`
  texture and its clear, but the pyramid scatter still needs float blending.
- **Async shader compile** (`KHR_parallel_shader_compile`, luma `compilation-status-async-webgl`) to
  take the ~0.5 s construction task off the main thread. PR 1 measures how much of it is compile and
  link; promote this into PR 6 if that share exceeds ~150 ms.
- **Timer-query budget controller** (`EXT_disjoint_timer_query_webgl2` via a luma `QuerySet`), only
  if a non-M1 device shows the fence controller mis-sizing `k` or `B`.
- **#<nested-coincident-fix>** (file now, fix before gpu-nested): the CPU `collide()` flings
  coincident discs ~1e8 apart (§11.1). A live bug in the CPU nested layout, independent of the GPU.

## 17. Related issues

#333 (primitive), #184 (GPU to renderer), #124 (convergence stop), #312 (multilevel on the fallback),
#311 (backend swap), #297 (live transport), #181 (containment), #189 (state layouts), #180 (module
seed), #183 (drag reheat), #251 (near-field softening), #141 (PBO pick readback, pattern reused),
#324/#326/#328/#329 (nested layout, hierarchy, warm start, boundary rings), #106 (N8 epic),
#<seed-scale> (shared schedule), #<lod-frame-waste> and #<lod-incoherent> (engine-side streaming
cost).

## 18. Review notes (revision 2)

Three review lenses produced 41 findings. Each was checked against the code (`main` at 78ce0d9, the
uncommitted `fix/layout-seed-equilibrium` worktree, and luma.gl 9.3.3's installed source) before it
was accepted. W = webgl-feasibility, N = numerics-correctness, E = engine-integration.

| ID | Finding | Verdict | Where addressed / reason |
|---|---|---|---|
| W1 | Budget counted in whole ticks cannot hold when one tick > budget | Accepted | §6.5.3 band slicing (work items P / F_b / I, scissor bands, controller counts items); §3, §10.1 |
| W2 | luma cannot create `STREAM_READ` PBOs | Accepted (verified `webgl-buffer.ts` `getWebGLUsage`) | §6.5.2 raw PBOs like `PickReadback`; T7 asserts `BUFFER_USAGE` |
| W3 | fps targets omit measured main-thread engine costs | Accepted | §2, §10.3 split transport-only vs user-visible; §6.5.4 throttle; T7 |
| W4 | Fence gate vs convergence-time model disagree | Accepted | §6.5.3 up to 2 frames in flight; §10.1 ticks/s; §10.3 converge 2.5-5 s; T7 ticks/s |
| W5 | Alpha baked into `stab` goes stale under cooling | Partly rejected | The CPU on `fix/layout-seed-equilibrium` also bakes `params.alpha` (not `alpha·heat`) into `springStabilizers`, so the GPU matches it and cooling stays a uniform write; §8 records this and the in-shader variant if the schedule ever changes |
| W6 | Hub chunk pass cannot sit inside the force pass | Accepted | §6.3, §7 (own render pass, fixed order) |
| W7 | Readback fence doubles as budget fence; undefined when skipped | Accepted | §6.5.3 one budget fence per frame, always |
| W8 | Sub-rectangle writes clear the whole texture by default | Accepted (verified `WEBGLRenderPass.clear`, `RenderPass.defaultClearColor`) | §6 clear rule; T3 ℓ ± 2 check |
| W9 | Row-major slots mix segments in one quad | Accepted, decision split | §5.1 one mapping function, row-major for flat; §11.1 divergence factor + measured blocked mapping in gpu-nested; §16 |
| W10 | Bitwise claims for rewritten shaders | Accepted | §9 bitwise only for `segBox` and same-program determinism; tolerances elsewhere |
| W11 | T7 blind to GPU-process stalls; harvest order unspecified | Accepted | §6.5.1 harvest before encode; T7 throughput leg, order spy, Firefox/WebKit runs |
| W12 | New programs lengthen the synchronous construction task | Accepted (recorded) | §10.3 construction row; PR 1 measures the split; §16 async compile with a promotion threshold |
| N1 | Stop checked per frame is timing-dependent; zero-velocity first sample | Accepted, constants corrected | §6.5.5 per-tick GPU latch, first sample ignored; T9. The branch's rule is `step < 0.06·spacing && step ≤ prevStep` (`CONVERGED_STEP`), not 0.02 / `stopRun` |
| N2 | `setLevel` keeps stale velocities, pins, stab | Accepted | §6.4 per-level reset (vel = 0 by MRT, pinned zero, stab per level); T10 |
| N3 | Mass-weighted coarse levels vs "mass stays 1" | Accepted, option (a) | §5.3, §5.4, §6.2.1, §8: coarse levels carry mass and weights; §6.4 restates the seed-quality claim (measured on the unweighted seed) |
| N4 | Relative tolerances on cancelling sums are flaky or vacuous | Accepted | §6.1 bound `D·ε·Σ\|term\|`, pairwise fragment sums; §9; T1 offset distribution, `count = 0`, `16^ℓ` straddles; T3, T4 bounds |
| N5 | BH discontinuities make trajectory tolerances fail | Accepted | §9 forces from identical positions, p99 + outlier cap; T5. The debug `degreeCap` option is rejected: identical-input force comparison isolates the 5 hub rows exactly |
| N6 | K-occupant grid misses pairs | Accepted | §11.1 cell from r₉, large = radius > cell/(2·PAD), counted occupancy + extra rounds, symmetric pairs; stage-2 test |
| N7 | Nested integration constants differ from the CPU | Accepted (verified `nested-layout.ts`) | §11.1 multiplier 0.6, stab ≡ 1, no maxStep, `v*` predictor, ε 1e-9 / 1e-8 |
| N8 | CPU flings coincident discs apart | Accepted (verified) | §11.1 GPU rule; CPU fix as #<nested-coincident-fix> before gpu-nested (§14, §16) |
| N9 | One-pass variance in `placeOver`; no `known` mask | Accepted | §11.1 two range passes over known leaves |
| N10 | Force pass order matters (ADD is not associative) | Accepted | §7 fixed order springs → repulsion → centering, as today's `_tick` |
| N11 | Empty ranges and NaN poison the stop rule | Accepted | §5.2 `max(count, 1)`; §6.5.5 NONFINITE flag; §6.5.6 stop + warn; T1, T9 |
| N12 | `segBox` is one tick stale | Accepted (documented) | §6.5.5: lag ≤ one step (≈ 1.2% of the radius at 325k); a per-frame rebuild is not worth it |
| N13 | Nested stop rule not in the CPU reference | Accepted | §11.1 fixed T, as on the CPU; the global stop tree is removed |
| E1 | LOD per-frame cost deferred; Navigator switch unsafe | Accepted (blocker) | §2, §12.1 options + PR 3c; §12.3 gate; T7 LOD leg vs the worker baseline |
| E2 | Adopting the tree as `lodWorkerTree` freezes geometry | Accepted (verified `network.ts:1772`, `:2756-2763`) | §6.4, §12.1 adoption semantics per option; `{ type: "coarsen" }` protocol; T8 aggregate test |
| E3 | Fallback cannot keep "all options" inside `startGpuLayout` | Accepted (verified `network.ts:1388-1394`) | §6.6 options passthrough, `lodStreaming`, LOD guards on the resolved transport; T8 |
| E4 | `"auto"` breaks 16 literal backend checks | Accepted (counted 16) | §12.2 resolved class + transport; PR 2c lists every check; T8 `"auto"` legs |
| E5 | §8 contract does not match the real branch | Accepted | §8 rewritten against `Cooling`, per-tick `converged`, `DRAG_HEAT`/`RECOOL_TICKS`, optional `frameEvery`; land #<seed-scale> first |
| E6 | Phase 2 bundles too much; #311 policy has gaps | Accepted (verified swap order in `base-engine.ts` / `webgl-backend.ts`) | §14 split into 2a/2b/2c; §6.6 pre-swap hook, remaining ticks + heat; Q3 idle-worker memory |
| E7 | Phase 6 needlessly depends on phase 5; 7-on-6 unexplained | Accepted | §6.4 root-level uniform; §14 dependencies and order |
| E8 | Pins, stop and frames undefined during coarse seed levels | Accepted | §6.4 queued pins, cancel on stop, seed frame, `iterations: 0`; T10 |
| E9 | GPU nested misses boundary discs and the one-frame warm contract | Accepted (verified `network.ts:1508-1517`) | §11.1 boundary-disc readback, `stream: false` for warm/tween; §12.3 RELAYOUT outcome restated |
| E10 | Readback memory trade-off not put to the maintainer | Accepted | §15 Q9 with quantified options; §10.2 |
| E11 | No fence when readback is skipped; encode cost ignored at small N | Accepted | §6.5.3 fence every frame, encode-time cap; T7 asserts encode ms |
| E12 | Separate rAFs delay the repaint a frame and queue render behind ticks | Accepted | §6.5.1 engine-driven frame source: harvest + repaint before the render, layout encode after it, in one rAF |
| E13 | T7 drives a proxy, not the real trigger | Accepted | T7 drives `network().layout()` with LOD on and off |
| E14 | "Existing tests pass unchanged" cannot hold across the series | Accepted | §9 limits it to PRs 1, 2a, 5; §14 lists changed tests per PR; #124 closes with the stop |
| E15 | No context-loss handling | Accepted (verified: no handler in `src/`) | §6.5.6; PR 3a detection, PR 2b restart; T8 |
| E16 | Timer path is a rarely-run second controller | Accepted | §6.5.3 fence controller only; §16 follow-up |
