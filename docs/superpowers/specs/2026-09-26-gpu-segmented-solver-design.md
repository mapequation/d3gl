# GPU segmented force solver: phase 1 through the flat path, plus async readback

**Date:** 2026-09-26
**Status:** Draft design, pre-implementation
**Issues:** #333 (the primitive), #184 (GPU to renderer), #124 (convergence stop), #312, #311, #297,
#181 and #189 (later consumers), epic #106 (N8)
**Builds on:** `docs/superpowers/specs/2026-07-02-n8-gpu-layout-design.md` (N8)

## 0. Summary

`layout({ backend: "gpu" })` works today but is not smooth. On web-NotreDame (N = 325,729 nodes,
E = 1,497,134 edges) a tick costs 45-51 ms. 80% of that goes to two passes that scatter all N points
into one pixel. Each streamed frame then blocks the main thread for about 230 ms on a synchronous
`readPixels`, so the UI runs at about 4 fps and 300 fixed ticks take 13.4 s.

This spec turns the existing `GpuForceLayout` into the **segmented solver** that #333 asks for. Nodes
live in *slots*, grouped into *segments*. Forces never cross segment boundaries, and reductions work
per segment. The flat layout is the case with exactly one segment. Phase 1 builds the primitives and
lands them through the flat path, where they fix the measured problems:

1. **Segmented reductions** with no blend contention replace both 1-px scatters. Target tick at
   325k: about 13-17 ms instead of 45-51 ms.
2. **Tile-atlas grid pyramid**: the flat layout is one tile. Levels are packed into three textures,
   so the traversal needs 3 samplers instead of 11. There is an exact loop for small segments and a
   softening per segment.
3. **Chunked CSR spring rows** remove the 4096-neighbour cap. Today the cap drops 13.5k half-edges
   on 5 web-NotreDame hubs.
4. **One solver reused across multilevel levels**, plus a **structural multilevel seed** for plain
   graphs built from the coarsening tree (#312 parity).
5. **Async fenced readback** (PBO + `fenceSync`), a **GPU time budget** per frame, and a
   **convergence stop** driven by the kinetic-energy reduction (#124).
6. **Capability checks** (float render targets, `EXT_float_blend`, texture limits, read format) with
   a clean fallback to the worker (#311, #297).

Phase 2 reuses the same solver with many segments: the nested layout becomes **one** batched solve
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
| Readback per streamed frame | ~230 ms main-thread block (the copy itself is 2.1-2.8 ms) | `gpu-transport.ts` `step()` |
| Streamed frame rate during layout | ~4 fps | |
| 300 ticks | 13.4 s | |
| GPU memory | ~50 MB | §10 |
| Construction (CSR, uploads, shader compile, first readback) | 572 ms | |
| Hubs over the 4096-neighbour cap | 5 (degrees 10,721 … 4,283), 13,507 half-edges dropped | `degstats.mjs` |
| BH accuracy vs exact | relative L2 error 0.8-2.2% at θ = 0.9 | |

The measurements come from the investigation harnesses in the session scratchpad (`gpu-layout/`,
`nested-333/`). They are not part of the repo. Only one device was measured (see §15, Q7).

## 2. Goals and non-goals

### Goals

- A reusable **segmented GPU force solver** in `packages/d3gl/src/network/gpu/`. It uses slots
  grouped by segment and a segment table. Repulsion, springs and centering stay inside a segment.
  Reductions (centroid, bbox, extent, count, kinetic energy) run per segment or per contiguous slot
  range. The solve is deterministic on a given device.
- **Flat equals today.** On the flat path, web-NotreDame must reproduce today's single-pyramid
  behaviour numerically, within the tolerance in §9. The documented exception is hubs above 4096
  neighbours, whose dropped springs come back.
- **Flat pays nothing for segments.** The flat path adds no per-node texture and no per-tick O(N)
  pass beyond today's. The segment id is a compile-time constant when S = 1.
- At 325k: tick ≤ ~17 ms, main thread ≤ ~3 ms per streamed frame, ≥ 40 fps streaming with LOD off.
  With the seed and the stop rule, the layout should converge in about 100-150 ticks
  (≈ 1.5-2.5 s) instead of 300 fixed ticks (13.4 s).
- Plain graphs get a multilevel seed on the GPU. The worker fallback honours `multilevel` (#312).
- The GPU path adopts the shared force schedule from `fix/layout-seed-equilibrium` (§8), so CPU,
  worker and GPU run the same physics and stop by the same rule.
- Every phase ships on its own and maps to an issue key (§14).

### Non-goals

- **No change to the force law**: 1/d repulsion, zero-rest springs, linear centering. The nested
  layout's rest-length springs and collision in phase 2 are the existing CPU nested algorithm, not a
  change.
- **A sort-based solver** (Morton sort + implicit fan-out-4 LBVH) is a follow-up issue only (§16).
- **GPU-resident positions** (#184 Milestone B): this spec only keeps the door open (§11.4).
- Changing the CPU nested algorithm's output, or re-implementing #181/#189 here.
- LOD per-frame cost on the main thread (`computeLODGeometry` 16-23 ms per frame for the GPU backend).
  Other work tracks it. It will limit the frame rate with LOD on once the solver is fast (§10.3).
- The fit problems (#309/#327, loose fit box). This spec only notes that the GPU can report an exact
  bbox for free (§6.5).

## 3. Binding decisions (from the maintainer)

1. **GPU solver.** Build #333's primitives (segmented reductions, tile-atlas grid pyramid, chunked
   CSR springs, one solver reused across multilevel levels) by **refactoring the existing
   `GpuForceLayout`**. Land them through the **flat path first** (flat = one segment); nested
   (many segments) comes later. The sort-based solver is only a follow-up issue.
2. **GPU to renderer.** First an **async (fenced, PBO) readback** with a **GPU time budget per
   frame**. GPU-resident positions (#184) come later.
3. The force law stays as it is.

## 4. Architecture

### 4.1 Layers

```
CPU prep (once per topology; pure, node-testable)       GPU pass graph (per tick)              Transport (per rAF)
─────────────────────────────────────────────           ─────────────────────────              ───────────────────
segments.ts:  slot order + permutation                  reduce tree → range query              budget controller
              segment table, tile packing       ──►     tile scatter → packed reduce   ──►     encode k ticks
              reduction ranges                          springs (rows + hub chunks)            pack → PBO → fence
              CSR in slot ids, hub chunks               repulsion (tile root | exact)          harvest when signalled
schedule:     alpha(t), maxStep, stop rule              centering → integrate (MRT)            stop rule on stats
```

- **`GpuForceLayout` stays the solver class.** It is refactored in place and stays internal (not
  exported from the package). Its constructor takes a `SolverTopology` (slots, segments, ranges,
  CSR) instead of a bare `LayoutGraph`. `flatTopology(graph)` builds the S = 1 case, so every
  existing caller and test keeps its shape. A rename to `SegmentedForceSolver` would only be
  cosmetic. If wanted, it lands with gpu-nested.
- **Segments vs ranges** (the one new concept). A **segment** is an isolation unit: repulsion,
  springs and collision only act between slots of the same segment, and each segment with more than
  `exactMax` slots owns one pyramid tile. A **range** is a contiguous slot interval that the
  reductions can query. Segments are always ranges. Ranges can also nest, and they need no tile.
  This split lets one primitive serve every consumer:

  | Consumer | Segments | Ranges queried |
  |---|---|---|
  | Flat layout (phase 1) | 1 (all slots) | 1 (all slots) |
  | Multilevel seed level | 1 per level | 1 |
  | Nested (#333, phase 2) | one per parent module | = segments (+ leaf range for warm placement) |
  | Soft containment (#181) | 1 (global repulsion) | every module, nested (leaves in module-DFS slot order) |
  | State layouts (#189) | "two-phase": one per physical node; "force": 1 | one per physical node |
  | GPU LOD aggregates (#184 later) | — | every LOD tree node (DFS order) |

### 4.2 Architecture check

Is refactoring `GpuForceLayout` right, or is the abstraction wrong? The current class is fine as a
solver *shell* (ping-pong, MRT integrate, pinned mask, stabilizer, CSR upload). Three things are
wrong:

- it assumes **one global box** (the 1×1 bbox and centroid targets);
- it has **one sampler per pyramid level**;
- it has **one class instance per multilevel level**.

All three are single-segment special cases of the segmented design, not separate abstractions.
Generalising them in place gives the clean design without a second solver next to the first. The
thing we must *not* do is add segment awareness as adapters around the 1-px reductions. Those passes
are the measured bottleneck and must go, not be wrapped.

## 5. Data model

### 5.1 Slots and the permutation

- A **slot** is a texel index in the solver's per-node textures, stored row-major in an atlas of width
  `W = atlasWidth(capacity)` (`textures.ts`).
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
  3. The **readback pack pass** gathers positions into node-id order on the GPU (§6.5), so the CPU
     always receives node-id order.
  4. #184 later: the renderer reads that same node-order texture.
- Flat phase 1 uses the **identity** (no texture, compile-time `#define IDENTITY_SLOTS`). With the
  permutation in place, a Morton/Hilbert reorder of the flat layout becomes a later option with no
  API change: measured −19% BH, −10% attraction (§16).

### 5.2 Segment table (S texels each, atlas width `atlasWidth(S)`, `nearest` sampling)

| Texture | Format | Channels | Written |
|---|---|---|---|
| `segInfo` | `rgba32ui` | `start`, `count`, `tileOrigin = ox \| oy << 16`, `rootLevel \| flags << 8` (flags: `EXACT`, `FROZEN` for k = 1, `HAS_TILE`) | once per topology |
| `segParam` | `rgba32f` | repulsion strength, centering/gravity strength, softening ε, alpha0 | once (per-segment `alpha0` supports warm/cold nested segments) |
| `segBox` | `rgba32f` | `(maxX, maxY, −minX, −minY)`, the same packing as today's `boxTex` | per tick (range query, §6.1) |
| `segStats` | `rgba32f` | `(Σx, Σy, Σ\|v\|, count)` → centroid and mean step | per tick (range query) |

Phase 2 adds `segAnchor` (`rgba32f`: anchor x, y, γ, mode; for #181/#189) and `segShape` (`rgba32f`:
m_x, m_y, extent, scale; for nested composition). With S = 1, `segInfo`/`segParam` are still 1×1
textures. The same shader code runs; only the segment-id lookup is constant.

### 5.3 Per-slot textures

| Texture | Format | Flat (phase 1) | Nested (phase 2) | Notes |
|---|---|---|---|---|
| `pos` ×2 (ping-pong) | `rg32f` | yes | yes | as today |
| `vel` ×2 (ping-pong) | `rg32f` | yes | yes | as today |
| `force` | `rg32f` | yes | yes | ADD-blend accumulator, cleared per tick |
| `pinned` | `r8unorm` | yes | yes | as today (#183) |
| `nodeAttr` | flat: `r32f` (stab); nested: `rgba32f` (stab, radius, mass, —) | stab only (today's `stabTex`) | yes | `mass` stays 1 in every phase here. Weighting repulsion by mass would change the force law and needs its own decision |
| `slotSeg` | `r32ui` | **no** (`#define SINGLE_SEGMENT`, id 0) | yes | segment id per slot |
| `slotOfNode` | `r32ui` | no (identity) | yes | readback gather (§6.5) |

### 5.4 Springs (CSR in slot ids)

- `offsets` `r32ui` (count + 1) and `neighbors` `r32ui` (2E): today's symmetric `buildCSR`, rewritten
  into slot ids.
- `weights` `r32f` (2E), only when a consumer has per-entry weights or rest lengths (nested: sibling
  weights and the collide-phase rest mode). Flat compiles without it (`#define UNIT_SPRINGS`).
- `hubChunks` `rgba32ui` (row slot, entry start, entry end, —) and `hubPartials` `rg32f`: one texel
  per chunk of a row with more than C = 256 entries (§6.3).
- Nested springs never cross segments, because sibling links only join children of one parent. The
  CPU builder asserts this. A cross-segment entry would break isolation (tested, §13).

## 6. Primitives

All passes are luma.gl v9 (9.3.3) `Model`s. Each is a full-screen triangle over a target atlas, or
a `point-list` scatter. Uniforms go in the mutable-record pattern used today. Every texture,
framebuffer and buffer is created at construction or at `setLevel`, never per tick (§13 spies).
Phase 1 lands the shared full-screen pass helper that is already listed as a TODO in
`passes/attraction.ts`, as its own commit. Six passes duplicate that setup today.

### 6.1 Segmented reductions (contention-free)

**Problem.** `CentroidReducePass` and the pyramid bbox pass draw N points to texel (0,0). Blending
serialises on that one texel: 17.3 ms + 18.8 ms at 325k.

**Design: a 16-ary reduction tree over slot order, plus a canonical-cover range query.**

1. **Tree build.** Level 1 has `ceil(N/16)` texels, and texel j covers slots `16j … 16j+15`. Level ℓ
   texel j covers `[16^ℓ j, 16^ℓ (j+1))`. Each level is one full-screen pass. The fragment for
   output texel j does 16 `texelFetch`es from level ℓ−1, with **no blending**. There are two
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
   apply the map directly. The query writes `segStats` and `segBox` by MRT.
3. **Level storage (luma constraint, §6.2.3).** A tree level is a 1D array packed into rows. Odd
   levels live in texture A and even levels in texture B, so a level pass never samples the texture
   it renders into. Writes into a level's rows use `beginRenderPass({ parameters: { viewport } })`
   (supported by luma 9.3.3 `WEBGLRenderPass`). The query samples A and B (4 samplers for 2 chains).

**Properties.**
- Contention-free and gather-only: it needs **no float blending**.
- Deterministic: the fetch order is fixed.
- **min/max are exact**, so the flat `segBox` is **bitwise identical** to today's 1×1 bbox.
- Float32 tree sums have O(log N · ε) relative error, better than serial blending. Centroid error at
  325k is about R·ε·log N ≈ 0.02 world units against a spacing of 56.
- Prefix sums are rejected: the cancellation error is too large at 1M.
- A scatter per segment is rejected: its contention is ∝ count, so S = 1 would be today's problem.

**Uses of the outputs.**
- `segBox` feeds the tile scatter (§6.2) in place of `boxTex`.
- `segStats.xy / count` feeds centering (and is the pyramid root's value).
- `segStats.z / count` is the **mean step** for the convergence stop (§6.5).
- A second, tiny tree over `segStats` (S texels) gives the global total when S > 1 (the nested stop
  rule).

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
  per cell (0.2-0.6 ms at 325k today).

#### 6.2.2 Traversal

- The stack-based BH traversal is unchanged except for its root and cell geometry:
  - root = `(rootLevel_s, ox >> rootLevel_s, oy >> rootLevel_s)` with `rootLevel_s = log2 G_s`;
  - children at `(2cx+{0,1}, 2cy+{0,1})` stay inside the tile automatically;
  - cell size at level ℓ is `boxSide_s / (G_s >> ℓ)`;
  - the level-0 cell centre is `lo_s + ((cx − ox) + 0.5) / G_s · boxSide_s`. For the flat tile,
    ox = 0, so this is the **same expression** as today, which keeps the #251 single-occupant
    variance cancelling exactly.
- **Softening per segment**: ε comes from `segParam.z`.
  - Flat keeps today's absolute `1e-2`.
  - Nested segments are solved in a unit-disc frame. There ε reproduces the CPU reference's
    effective softening: the CPU runs BH in a ×1000 frame (`BH_SCALE`) with the absolute 1e-2, which
    is 1e-8 in unit coordinates. Confirm against `nested-layout.ts` `repel()` when implementing.
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
    Writes target the level's rectangle through the render-pass `viewport`. The shader subtracts the
    rectangle offset from `gl_FragCoord`, and per-level offsets are a uniform array.
  - `fetchCell(level, cx, cy)` becomes a 3-way branch instead of today's 11-way unrolled switch.
  - The largest dimension is `A`, the same device limit as today's single level.
  - At G = 1024 this uses 23.3 MB instead of 22.4 MB (+4%, §10.2).
  - Alternative: one mip texture plus raw-GL base/max clamps. It saves the 4% but adds a raw-GL
    seam. Maintainer decision (§15, Q2).

#### 6.2.4 Exact loop

For a segment with `count ≤ exactMax`, loop `j ∈ [start, start+count)`, skip self, and use the same
kernel. This is `repulsion-allpairs.ts` with bounds from `segInfo`. Flat with N ≤ 4096 loops
`j = 0 … N−1` in the same order as today, so the result is bitwise the same.

#### 6.2.5 Texture-unit budget

The WebGL2 minimum is 16 units. Today the pyramid pass binds 13 (u_pos, u_box, 11 levels).

| Pass | Samplers (flat → nested) |
|---|---|
| Tree level 1 / level ℓ | 2 (pos, vel) / 2 |
| Range query | 7 (tree A/B × 2 chains, segInfo, pos, vel for level-0 heads) |
| Tile scatter | 3 → 4 (pos, segBox, segInfo, + slotSeg) |
| Pyramid reduce | 1 |
| Repulsion | 7 → 9 (pos, segInfo, segBox, segParam, L0, Podd, Peven, + slotSeg, nodeAttr) |
| Springs (rows / hub chunks / partial gather) | 3 → 4 / 3 → 4 / 2 |
| Centering | 3 → 5 (pos, segStats, segParam, + slotSeg, segAnchor) |
| Integrate | 5 → 7 (pos, vel, force, pinned, nodeAttr, + slotSeg, segParam) |
| Readback pack | 1 → 2 (pos, + slotOfNode) |
| Collision (phase 2) | ~10 (pos, nodeAttr, slotSeg, segInfo, segBox, 4 occupancy, large list) |

Every pass stays at or below 10. A texture-unit capability check is not needed (§6.6).

### 6.3 Chunked CSR spring rows

- **Rows with ≤ C = 256 entries** (all but a few hundred nodes on web graphs) keep today's gather,
  one fragment per slot. The loop order is unchanged, so these rows are **bitwise identical**. The
  4096 cap is removed. A slot whose row is longer than C skips the row loop.
- **Rows with > C entries** are split into chunks of ≤ C entries. The CPU builds `hubChunks`.
  1. The **chunk pass** has one fragment per chunk. It sums `pos[j] − pos[i]` (times the weight, if
     any) into `hubPartials` (`rg32f`, no blend).
  2. The **partial gather**: the hub's own row fragment sums its chunks' partials. It finds its
     `(firstChunk, chunkCount)` by binary search in a small `hubRows` table sorted by slot
     (H ≤ a few thousand entries, so ~12 fetches, and only on the rare hub branch). There is no
     per-slot texture, so flat pays nothing. The partials are gathered, not blended, so the result is
     deterministic and needs no extra ADD pass.
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
  - `setLevel({ count, csr, segments })` sub-uploads the level's CSR and attributes into the capacity
    textures (`writeData` sub-rectangles) and updates uniforms (`u_count`). The atlas width W stays
    fixed.
  - A level's pyramid is a tile of side `chooseGrid(count)` at origin (0,0) inside the capacity-sized
    `L0/Podd/Peven`. The traversal starts at that tile's root level (§6.2).
  - Changing level allocates nothing (spy-tested, §13).
- **Prolongation** (`ProlongatePass`, unchanged shader) reads the coarser level from the read-side
  position texture and writes the finer seed into the write side. Then the ping-pong swaps, so there
  is no feedback loop. Both levels share W, so a parent slot maps to a texel with one width.
- **No per-level readback.** A leaf that ends at depth d (ragged module trees, #180) is written
  straight into a transient node-order `leafSeed` texture (`rg32f`, N texels) by a `point-list`
  pass with no blend (each leaf once). The finest level seeds from `leafSeed`, which is then freed.
  The #180 semantics are preserved exactly: a terminal leaf is placed with its parent and never
  subdivided.
- **Seed work runs inside the streamed, budgeted loop** (§6.5) as work items `(level, ticks)`. A
  coarse level solve therefore never queues hundreds of ms of GPU work in front of the renderer. No
  frame is emitted until the finest level has ticked once.
- **Structural seed for plain graphs.**
  - The coarsening LOD tree (heavy-edge matching, `buildLODTree`) already carries `parent[]` and
    super-edges and passes `canModuleSeed`. On web-NotreDame it has 13 levels (325,729 → 59,100 →
    23,362 → 9,627 → … → 5 roots).
  - Measured with the existing seed: rescaled to the equilibrium radius, it reaches at tick 100 the
    quality the disc seed reaches at tick 300 (mean edge 454 vs 585).
  - **Source of the tree: the layout worker** (recommended). The worker already coarsens for the
    worker multilevel path and streams the LOD tree. A coarsen-only request returns the topology as
    transferables. The GPU builds the solver and compiles its shaders in parallel (~0.5 s, overlapped).
  - The engine **adopts the same tree as the LOD tree**, like `lodWorkerTree`. This removes the
    244-308 ms main-thread `buildLODTree` that the GPU backend pays today when LOD is on.
  - The alternative (the main thread builds it) blocks for about 0.3 s (§15, Q7).
- **Scale.** The seed's disc radius, per-level scale and child offsets come from the shared schedule
  (§8). Today they are viewport-scaled (`0.4·min(W,H)`, `maxStep = 4·max(W,H)`), which causes the
  tick-6 fling (bbox 186k, then 36k).
- **#312 parity.** `multilevel` is forwarded into the GPU options. The GPU honours it
  (`multilevel: false` gives the disc seed), and so does the worker fallback. Today the fallback
  always runs multilevel.

### 6.5 Async fenced readback, GPU time budget, convergence stop

#### 6.5.1 Readback

- **Pack pass.** One fragment per output texel t writes node ids 2t and 2t+1 as
  `(x0, y0, x1, y1)` into a staging `rgba32f` texture of `ceil(N/2)` texels (node-id order, through
  `slotOfNode` when the permutation is not the identity). It keeps positions out of the `RG/FLOAT`
  read format, which `readPixels` does not guarantee. `EXT_color_buffer_float` guarantees
  `RGBA/FLOAT` from an `rgba32f` attachment.
  - Fast path: when the implementation's read format for the position FBO is `RG/FLOAT` and the
    permutation is the identity, the pack pass and the staging texture are skipped. This is queried
    once through `IMPLEMENTATION_COLOR_READ_FORMAT/TYPE`.
  - The same node-order texture is what the renderer will sample in #184.
- **Copy.** luma 9.3.3 `Texture.readBuffer(options, buffer)` issues `readPixels` into a
  `PIXEL_PACK_BUFFER`. This is a GPU-side copy that does not block, and it reuses the texture's
  cached read framebuffer (checked: it allocates nothing per call). There is a ring of **2**
  preallocated PBOs (`STREAM_READ`), plus a 32-byte stats PBO pair for the S = 1 `segStats` +
  `segBox`.
- **Fence.** `gl.fenceSync(SYNC_GPU_COMMANDS_COMPLETE)` after the copy.
- **Harvest.** On a later rAF, poll `clientWaitSync(sync, SYNC_FLUSH_COMMANDS_BIT, 0)`. This reuses
  the #141 lesson in `webgl/pick-readback.ts`: without the flush bit, a fence can stay unsignalled
  under headless contention. When the fence has signalled, call `getBufferSubData(PIXEL_PACK_BUFFER,
  0, graph.positions, 0, 2N)` straight into the existing positions array. **No per-frame
  allocation.**
  - luma's `Buffer.readSyncWebGL` allocates a new `Uint8Array` per call, so the harvest uses the raw
    handle. The code reaches it by narrowing `device instanceof WebGLDevice` and
    `buffer instanceof WEBGLBuffer`, which needs no cast. (The existing casts in `webgl-backend.ts`
    are not the pattern to copy.)
  - Today's `readPositions` allocates two ~2.6 MB arrays per frame; that goes away.
  - The fence + PBO-ring helper is shared with `PickReadback`.
- **Never block.** If both PBOs are pending, this frame issues no new readback; ticking continues.
  Positions lag the GPU by 1-2 frames. During a drag, `dragReapply` already keeps held nodes under
  the cursor on the CPU.
- **`settled`** resolves only after the positions of the final tick have been **harvested**. The
  settle handler's `recomputeLODGeometry(true)` therefore sees final positions.
- Synchronous `readPositions` stays only for tests and one-off reads, never on the streaming path. A
  spy enforces this (§13).

#### 6.5.2 GPU time budget

- The loop encodes `k` ticks per rAF and keeps **at most one frame of layout work queued**, so the
  renderer (which shares the GPU) never waits for more than one budget.
- **Default controller (portable, fence-driven, AIMD with hysteresis).**
  - If the previous frame's fence has not signalled at rAF start, the GPU is behind: encode **no**
    ticks this frame, set `k = max(1, ⌊k/2⌋)`, and hold `k` for 30 frames.
  - Otherwise, once the hold has expired, set `k = min(kMax, k + 1)`.
  - `kMax = 16`, and `k ≥ 1` while running.
  - The hold stops `k` from swinging between 1 and 2 when one tick costs about a frame (325k: at most
    one skipped frame per ~31).
  - Without timer queries, the effective budget is "at most one frame of GPU work queued"; `budgetMs`
    is enforced exactly only on the timer path below.
- **Timer path** (when the device has luma's `timestamp-query` feature, which is
  `EXT_disjoint_timer_query_webgl2` through luma's WebGL timestamp `QuerySet` of `TIME_ELAPSED`
  pairs):
  - track the per-tick cost `c` as an EMA;
  - set `k = clamp(⌊budgetMs / c⌋, 1, kMax)`;
  - discard samples after a disjoint event.
- Chrome exposes the timer extension only in some contexts, so the fence controller is the default,
  not a fallback that rarely runs.
- `budgetMs` defaults to **10 ms** of layout GPU work per frame (§15, Q4). At 325k one tick is about
  15 ms, so the loop runs one tick per frame. At 30k it runs about 6 ticks per frame.
- The controller is a pure object (`gpu/frame-budget.ts`) and node-tested with a fake clock and fake
  fence states.
- Drag/cool reheat uses the same controller instead of the fixed `REHEAT_BATCH = 3`.

#### 6.5.3 Convergence stop (#124)

- The per-tick reduction already produces `Σ|v|` (§6.1). The stats PBO brings back 16 bytes per
  frame, and `meanStep = Σ|v| / count`.
- The **stop rule is the shared schedule's** (§8), for example `meanStep < ε·spacing` for W
  consecutive frames with `spacing = √(π·repulsion/centering)` (56 with the defaults), plus a safety
  cap on ticks.
- The loop then goes **idle** and the layout stays alive for drag reheat, as today (#183).
- With readback lag, the loop may tick 1-2 frames past the stop point, which is harmless.
- `segBox` comes back for free in the same PBO. The handle can expose it as an exact live bbox (a
  possible input for fit). Adopting it in `fitViewToLayout` is a separate decision.

### 6.6 Capability checks and fallback

- Rename and extend `device-caps.ts` into a pure `gpuLayoutSupport(caps, need)` over a typed
  `GpuCaps` record. The record is extracted from the luma `Device` in one place, so it is
  node-testable without faking a `Device`. It returns `{ ok: true }` or
  `{ ok: false, reason }`. Checks:
  1. `device.type === "webgl"`.
  2. `float32-renderable-webgl` (`EXT_color_buffer_float`): `r32f`/`rg32f`/`rgba32f` render targets
     and `RGBA/FLOAT` readback.
  3. **`texture-blend-float-webgl`** (`EXT_float_blend`). This is luma 9.3.3's WebGL name. It does
     **not** map the WebGPU name `float32-blendable` on WebGL. It is needed for ADD-blend force
     accumulation, the pyramid scatter, and the phase-2 MIN-blend occupancy. **Today this check is
     missing**: a device without the extension passes and then draws wrong forces.
  4. **Limits against the graph**: `limits.maxTextureDimension2D` must cover the position atlas side,
     the CSR atlas side (`ceil(√2E)`), the pyramid `A`, and the staging side. The WebGL2 minimum of
     2048 covers 2E ≤ 4.19M, so 1M nodes at web density (2E ≈ 9.2M, side 3032) needs a larger
     limit. Desktop GPUs report 16384.
  5. The readback format needs no check (the design reads `RGBA/FLOAT`, §6.5). The `RG/FLOAT` fast
     path is probed.
  6. Optional **functional probe**, cached per device in a `WeakMap`: two ADD-blended points into a
     2×1 `rg32f` target, read back. It catches drivers that advertise the extensions but misbehave.
     It costs about 1 ms, once.
  7. Texture units need no check: every pass uses ≤ 10 (§6.2.5) and WebGL2 guarantees 16.
- **Fallback.** Fall back to `startWorkerLayout` with *all* options, including `multilevel` (#312).
  Emit one `console.warn` naming the reason. The handle's `transport`/`shared` report the live
  worker transport (#297: getters, not values captured once).
- **Backend swap (#311). Recommended policy:**
  - A GPU layout's lifetime is tied to its device. `Network.onBackendSwapped` stops a layout whose
    device is not the new backend's device and destroys its textures.
  - If that layout was still converging, the same options restart on the new backend **warm** (from
    the current positions, no re-seed). On Canvas/SVG that resolves to the worker.
  - If it had settled, an idle worker handle is created so drag reheat keeps working.
  - This needs a "seed from current positions" option on the flat worker path (the nested path has
    `initial`).
  - The alternative is stop-only (§15, Q3).

## 7. Tick pipeline (flat, phase 1 complete)

| # | Pass | Target | Blend | Replaces |
|---|---|---|---|---|
| 1 | Tree level 1 (map) + levels 2…5 | tree A/B (MRT sum + box) | none | — |
| 2 | Range query | `segStats` + `segBox` (MRT) | none | 1-px centroid scatter (17.3 ms), 1-px bbox scatter (18.8 ms) |
| 3 | Tile scatter | `L0` | ADD | pyramid scatter (reads `segBox` instead of `boxTex`) |
| 4 | Packed reduce ×(levels − 1) | `Podd`/`Peven` rects | none | per-level textures |
| 5 | Clear `force`; springs (rows ≤ C); hub chunks → partials; repulsion (tile root or exact); centering (range centroid) | `force` | ADD (none for partials) | attraction / repulsion / centering |
| 6 | Integrate (`alpha(t)`, `maxStep` from the schedule) | `pos`/`vel` write (MRT) | none | integrate |
| per frame | Pack → PBO → fence; stats → PBO | staging | none | sync `readPixels` |

Each pass is followed by `device.submit()` as today. The order among the force passes does not
matter (additive).

## 8. The shared force schedule (alignment with `fix/layout-seed-equilibrium`)

A parallel branch changes the shared physics:

- an equilibrium-scaled seed: disc radius `√(repulsion·N/centering)`, 18,048 at 325k with the
  defaults;
- a step cap relative to the spacing;
- alpha cooling and a convergence stop;
- time-based frames.

The GPU path adopts that schedule by construction and does not define its own:

| Schedule item | GPU adoption |
|---|---|
| Seed (disc) | the GPU transport calls the same shared `seedPositions` |
| Multilevel seed scale | per-level scale and prolongation offsets from the same schedule function the worker multilevel uses |
| Step cap | uniform `u_maxStep` = schedule value (today `4·span0`; the `maxStep` option already exists) |
| Alpha cooling | uniform `u_alpha` = `alpha(t)` per tick (a uniform write, no allocation) |
| Convergence stop | evaluated on the async-read `meanStep` (§6.5.3) against the same threshold |
| Time-based frames | the budgeted rAF loop is already time-based; `onFrame` fires once per harvested readback |

**Contract with that branch.** The schedule must be a **pure function** of
`(params, N, tick, metric)`, with no access to CPU position arrays, so the transport can evaluate it
from 16 bytes of stats. The names are whatever that branch picks. Until it lands:

- gpu-reductions, gpu-float-blend, gpu-csr-chunk and gpu-tile-pyramid do not depend on it. They keep
  today's fixed-alpha semantics, and §9's flat equality is defined against today.
- gpu-async-readback ships the PBO/fence/budget part at once and turns on the stop rule when the
  schedule lands.
- gpu-ml-seed-plain needs the seed scale.

## 9. Flat equivalence contract (numerical tolerance)

"The flat web-NotreDame case equals today's single-pyramid behaviour" is defined per quantity:

| Quantity | Relation to today |
|---|---|
| `segBox` | **bitwise** (min/max are exact, same inputs) |
| Tile L0 cells, pyramid levels | **bitwise** (same box, same scatter order: GL blends in primitive order, same reduce) |
| Repulsion per node | **bitwise** given the same levels (same traversal, same cell-centre expression, ε = 1e-2) |
| Springs, rows ≤ 256 | **bitwise** (same loop order) |
| Springs, rows 257…4096 | equal within summation-order rounding (relative 1e-6) |
| Springs, rows > 4096 | **intentionally different**: the dropped entries come back (5 hubs on web-NotreDame) |
| Centroid | relative 1e-6 (tree sum instead of serial blend) |
| Positions after 1 tick / 10 ticks (degree ≤ 4096) | max \|Δp\| ≤ 1e-3 / 1e-2 × spacing |
| After 300 ticks | trajectories diverge chaotically, so compare distribution metrics instead: r99, r50/rmax, mean edge length within ±2% |

Enforcement is in §13 (T5). The existing GPU browser tests must pass **unchanged**, because they
encode today's behaviour: pyramid, convergence, stability, reheat, multilevel seed, backend
integration.

## 10. Cost model

### 10.1 Per tick (M1 Max; 325k measured per pass; 1M extrapolated as ×3.07 in N, BH × log factor 1.09)

| Pass | 325k today | 325k target | 1M today (extrap.) | 1M target (extrap.) |
|---|---|---|---|---|
| 1-px centroid scatter | 17.3 | **0** | ~53 | **0** |
| 1-px bbox scatter | 18.8 | **0** | ~58 | **0** |
| Reduction tree + range query | — | 0.3-0.6 (est.) | — | ~1-2 (est.) |
| Tile scatter + packed reduce | 0.7-1.1 | 0.7-1.1 | ~1.5-2.5 | ~1.5-2.5 |
| BH traversal, θ = 0.9 | 9.6-12.4 | 9.6-12.4 | ~32-41 | ~32-41 |
| Springs (rows + hub chunks) | 2.1 | ~2.2 | ~6.5 | ~6.7 |
| Centering + integrate | ~1 | ~1 | ~3 | ~3 |
| **Tick** | **44.5-51** | **~13-17** | **~155-165** | **~45-55** |

- G is capped at 1024, so at 1M the finest cells average ~1 node. BH stays in its intended regime.
- At 1M one tick uses up a 16 ms frame, so the loop runs one tick every frame, at about 20 fps.
- Morton ordering (a follow-up) would take BH from about 9.6 to 7.8 ms at 325k.

### 10.2 GPU memory per texture (bytes = texels × bytes per texel)

| Texture | 325k (W = 571) | 1M (W = 1000, 2E ≈ 9.2M) | Change |
|---|---|---|---|
| `pos` ×2, `vel` ×2 (`rg32f`) | 10.43 MB | 32.0 MB | = |
| `force` (`rg32f`) | 2.61 MB | 8.0 MB | = |
| `pinned` (`r8`) / `nodeAttr` flat (`r32f` stab) | 0.33 / 1.30 MB | 1.0 / 4.0 MB | = |
| CSR `offsets` + `neighbors` (`r32ui`, 1731² / 3032²) | 1.30 + 11.99 MB | 4.0 + 36.8 MB | = |
| `hubChunks` + `hubPartials` | < 0.1 MB | < 0.3 MB | + |
| Pyramid, today 11 textures | 22.37 MB | 22.37 MB | removed |
| Pyramid `L0` 1024² + `Podd` 640×512 + `Peven` 320×256 (`rgba32f`) | 16.78 + 5.24 + 1.31 = **23.33 MB** | 23.33 MB | **+0.96 MB** |
| Reduction tree, 2 chains (`rgba32f`) | **0.70 MB** | **2.13 MB** | + |
| 1×1 `sumTex`, `boxTex` | 32 B | 32 B | removed |
| Readback staging (`rgba32f`, N/2 texels) | 2.61 MB | 8.0 MB | + (0 on the RG fast path) |
| PBO ring ×2 | 5.22 MB | 16.0 MB | + |
| **Total** | **~50.3 → ~60 MB** | **~108 → ~135 MB** | |

- **CPU memory.** The readback lands in the existing `graph.positions`, so no new CPU buffer is
  added. Today's two 2.6 MB allocations **per frame** go away.
- **Multilevel.** Peak memory falls: one capacity-sized solver plus a transient `leafSeed`
  (2.61 MB at 325k) replaces a second concurrent `GpuForceLayout` per level.
- **Memory limits.** The largest single texture is the CSR (2E texels, 4 B). On a device with
  `maxTextureDimension2D` = 2048 the GPU path refuses graphs with 2E > 4.19M and falls back (§6.6),
  instead of failing at `createTexture`.

### 10.3 Per streamed frame (user-visible)

| | Today | Target |
|---|---|---|
| Main-thread block per frame | ~230 ms (sync fence) | ≤ ~3 ms (encode ~0.7 ms per tick + harvest memcpy ≤ 2 ms) |
| Frame rate during layout, 325k, LOD off | ~4 fps | ~40-60 fps (GPU-bound: 1 tick + render) |
| Frame rate, 325k, LOD on | ~4 fps | ~30 fps, limited by `computeLODGeometry` 16-23 ms per frame on the main thread (tracked elsewhere, §2) |
| Time to converge, 325k | 13.4 s (300 fixed ticks) | ~1.5-2.5 s (seed + stop, ~100-150 ticks; depends on §8) |

## 11. Phase 2: how the rest plugs in

### 11.1 Nested layout (#333): one batched solve over all depths

**The key insight** (from the nested investigation). A module's local solve reads only static data:
child weights, sibling links, the spiral seed or warm centroids. The parent's disc is read only when
the result is mapped into it. So **every module at every depth solves at once**: one segmented solve
over all tree nodes except the root, with segment = parent module. That is 100 ticks in total, not
D × 100. #333 currently proposes one solve per depth; this replaces it. Then come D cheap composition
gathers.

- **Slots.** Every non-root tree node is a child in exactly one segment. Segments are sorted by
  (parent depth, parent id), and within a segment slots follow the children CSR. k = 1 segments are
  `FROZEN`: local (0,0), no forces, composed as centre = parent and R = 0.9 R_parent, as on the CPU.
- **Per-slot attributes.** `radius = √(packing · max(w_i, floor) / Σw)` in the unit disc (the CPU
  formula) and `stab`. Per segment: `REPULSION = 0.04/k`, `GRAVITY = 0.08` toward the local origin,
  `alpha0` (1 cold, 0.1 warm), and ε (§6.2.2).
- **Schedule.** The segment's alpha decays as `alpha0 · (0.001/alpha0)^(t/T)`, computed in the
  shader from `alpha0` and the tick uniform. There are two phases, switched by a uniform at 0.6 T:
  - *repel*: tile or exact repulsion + gravity + zero-rest springs on predicted positions
    `x + v` (the spring pass reads `vel`);
  - *collide*: collision + rest-length springs `(ra + rb) · PAD` with `PAD = 1.15`.

  Velocity decay is 0.4 (a per-solver uniform; flat keeps 0.9). Links are the CPU
  `sparsifyLinks` output with weights (`weights` texture).
- **Collision: a K-occupant grid.**
  - Per segment the grid is a tile with cell size ≈ 2·p90(radius)·PAD.
  - **K = 4 occupancy passes.** Pass k is a `point-list` MIN-blend scatter into its own `r32f`
    texture. It writes the slot id (exact below 2^24) only when the id is greater than the value in
    occupancy texture k−1 of that cell. Separate textures avoid the feedback loop.
  - The **gather** checks the 3×3 cells × K occupants.
  - Slots with radius > half a cell are "large". Each segment keeps a list of them (≤ 8) that every
    member tests exactly.
  - Segments with k ≤ 32 use the exact loop.
  - The update is **Jacobi with 0.5 under-relaxation**, while the CPU is Gauss-Seidel. Parity is
    therefore defined by the invariants, not by bitwise positions (§13).
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
- **Warm start (#328).** The CPU `warmStart` precompute (O(tree)) supplies the initial local
  positions and `alpha0 = 0.1`. `placeOver` is a range reduction over the packed node-order leaves
  `(Σx, Σy, Σ|x|²)` followed by one uniform similarity transform in the pack pass.
- **Streaming.** All depths converge together, so the natural stream is one animation of the whole
  map. The top depths are visible from the first frame, which meets #333's "~0.5 s" criterion. The
  per-depth frames of the CPU path disappear (§15, Q5).
- **Cost.**
  - A tick costs about what the flat tick costs at N_tree slots, minus BH depth (walks are
    ~log k_s), plus in the collide phase 4 scatter passes and a 9K gather.
  - Estimate: ~10-20 ms per tick at 336k slots, so 100 ticks ≈ 1-2 s. The CPU takes 25.9 s cold and
    30.1 s warm (measured on a synthetic 325,729-leaf tree).
  - A 1M-leaf tree should take ≲ 5 s (#333 acceptance).
  - CPU prep (sparsify, tile packing, permutation) is O(tree + links · log links) and runs in the
    worker.
- **Tile memory.** `Σ G_s² ≤ ~4·N_tree`, so at 336k `A = 2048 × H ≤ 1024`: L0 ≤ 33.5 MB and the
  packed levels ≤ ~13 MB (`Podd` 1280×512 + `Peven` 640×256), about 47 MB in all. Past the device limit, the tile sides halve (coarser near field) as a
  documented degrade.
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
  primitive.
- Lifetime follows the §6.6 swap policy.

## 12. Layout backend selection, and what the Navigator changes

**Today.**
- `NetworkLayoutOptions.backend` is `"positions" | "force" | "worker" | "gpu"`. There is no
  `"auto"` layout backend (only the render backend has `"auto"`).
- `"gpu"` already falls back to the worker when there is no WebGL device, when the render backend is
  Canvas/SVG, or when float render targets are missing. It warns only when there is no device at all.
- `"gpu"` + `nested` always runs the CPU worker.

**Proposal** (a maintainer decision, §15, Q1). Add `backend: "auto"` in gpu-float-blend:
- it resolves after `whenBackendSettled()` to the GPU when `gpuLayoutSupport(caps, need)` passes for
  *this* graph, and to the worker otherwise (with the worker's own sync fallback);
- it prints **no warning** on fallback, because falling back is the expected outcome;
- `layoutTransport` reports what was resolved;
- `"gpu"` keeps meaning "I want the GPU", with a warning when it falls back;
- `"auto"` + `nested` resolves to the GPU once gpu-nested lands, and to the worker until then;
- the default of `layout({})` does **not** change in this series. Flipping it later is a separate,
  user-visible decision.

Alternatives: (a) no new value; the app passes `"gpu"`, which already falls back after
gpu-float-blend. (b) Make `"auto"` the default now. That changes the backend for every user,
including SSR and tests.

**Navigator changes** (`src/components/NetworkView.tsx`):
- `LAYOUT = { backend: "auto", fit: true, nested: true }`, or `"gpu"` if `"auto"` is not adopted.
  Change it once gpu-float-blend is released, so the fallback is safe on non-float-blend devices.
- `RELAYOUT.backend = "auto"`. It gains nothing until gpu-nested (a warm nested re-cluster, today
  about 30 s frozen at 325k) but costs nothing before.
- Nothing else is required. Positions stream through the same seam, and `whenSettled`, drag and
  `fit` are unchanged. The GPU path does not need COOP/COEP. The render backend must be WebGL (or
  `"auto"`, which upgrades) for the GPU layout to engage.
- Optional: show `net.layoutTransport` in a status readout.
- Bump `@mapequation/d3gl` as each phase is released.

## 13. Test plan

Node tests (`packages/d3gl/src/network/gpu/__tests__/`, root vitest):

- **T0 `segments.test.ts`**:
  - tile packing: every origin is a multiple of its side, tiles are disjoint, and S = 1 gives origin
    (0,0), side `chooseGrid(N)`, `A = G`;
  - canonical cover vs brute force over random ranges, including tails and single slots;
  - hub chunking covers every CSR entry exactly once, and no gathered row exceeds C;
  - the permutation round-trips.
- **`frame-budget.test.ts`**:
  - AIMD with fake fences, never more than 1 frame queued, `k ≥ 1`, timer path with disjoint samples
    discarded.
- **`device-caps.test.ts`**:
  - `gpuLayoutSupport` over typed `GpuCaps` records: missing float blend, missing float RT, limits
    too small for the CSR, all present.

Browser tests (`pnpm --filter @mapequation/d3gl test:browser <path>`):

- **T1 reductions vs a CPU reference** (`segmented-reduce.browser.test.ts`):
  - random segment sizes {1, 2, 31, 32, 33, 4097, 100k} with padded tails;
  - `segBox` bitwise equal to CPU min/max;
  - centroid and `Σ|v|` within relative 1e-6 of float64 sums;
  - two runs bitwise identical (determinism).
- **T2 segment isolation** (`segment-isolation.browser.test.ts`):
  - three segments share one world region;
  - moving segment B's positions leaves segment A's `force` texels **bitwise** unchanged (repulsion
    on both the tile and exact paths, springs, centering to its own centroid);
  - a cross-segment CSR entry is rejected by the builder.
- **T3 tile pyramid** (`gpu-pyramid.browser.test.ts`, extended):
  - per-tile mass is conserved at every level, and each tile root equals its segment's `segStats`;
  - the feedback-loop probe that settles §6.2.3.
- **T4 CPU/GPU parity**:
  - repulsion per node vs exact all-pairs per segment within today's tolerance;
  - springs on a star with a 10,721-degree hub (web-NotreDame's maximum) match the CPU sum within
    relative 1e-5, and Σ spring forces ≈ 0 (action-reaction);
  - `gpu-convergence.browser.test.ts` extended with a hub graph.
- **T5 flat equivalence** (`flat-equivalence.browser.test.ts`):
  - the S = 1 solver vs `gridPyramidReference`, a typed CPU helper in the test directory that
    implements today's tick exactly (the grid pyramid, #251 softening, CSR, centering, integrate, in
    `Math.fround`), at N = 5k with the pyramid forced, degrees ≤ 256;
  - 1 tick: max |Δp| ≤ 1e-3 × spacing; 10 ticks: ≤ 1e-2 × spacing;
  - plus a structural assertion (S = 1 tile = today's grid);
  - the reference helper is an executable spec of the GPU algorithm, and every later phase reuses it;
  - each phase PR also reports a one-off A/B on web-NotreDame (old vs new: 1-tick Δ, and r99 and
    mean edge length after the run) in its Performance section.
- **T6 per-frame perf guard** (AGENTS §5; `gpu-frame-budget-perf.browser.test.ts`, extended):
  - the per-tick wall-clock ceiling at `perfN(30_000, { max: 200_000 })` is kept, split as
    `c0 + c1·N` (existing);
  - **new deterministic signature: no `point-list` draw of ≥ N vertices into a 1×1 viewport** (the
    regression this series removes). A spy on `WebGL2RenderingContext.prototype.drawArrays` reads
    `gl.getParameter(VIEWPORT)`;
  - zero `createTexture`/`createFramebuffer`/`createBuffer` per tick, per `setLevel`, and per
    streamed frame.
  - The layout solver processes every node whatever the LOD state, so the LOD on/off split applies
    to the streamed-frame guard below, not to the tick guard.
- **T7 gpu-frame-budget guard** (new, `gpu-stream-perf.browser.test.ts`, joins the browser perf
  tier by name):
  - drive `startGpuLayout` at `PERF_BROWSER_N` through real rAF frames, **LOD on and off**;
  - assert the main-thread time per streaming callback (harvest + encode + the engine's repaint) is
    below `perfBudget(c0 + c1·N/local)`. A reintroduced sync fence costs the whole GPU batch and
    trips it;
  - no `readPixels` without a bound `PIXEL_PACK_BUFFER` on the streaming path (spy +
    `PIXEL_PACK_BUFFER_BINDING`);
  - no `getBufferSubData` before its fence has signalled;
  - frame f's fence has signalled before frame f+2 encodes (≤ 1 frame queued);
  - `settled` resolves only after the final positions have been harvested.
- **T8 engine integration** (`gpu-backend-integration.browser.test.ts`, extended):
  - fallback when float blend is disabled (luma `disabledFeatures`), reason logged, worker run;
  - `multilevel: false` gives a cold start on both the GPU and the fallback (#312);
  - a WebGL → Canvas swap stops the GPU layout (textures destroyed) and a later drag still reflows
    (#311);
  - `layoutTransport` reflects the live transport after a fallback (#297);
  - `backend: "auto"` resolves correctly.
- **Phase 2**:
  - the `nested-layout.test.ts` invariants run on GPU output (child discs inside parents, no sibling
    overlap within the PAD tolerance, linked siblings closer, determinism on one device, warm-start
    invariants), with a documented tolerance against the CPU reference on the Navigator's example map;
  - a 1M-leaf nested timing bench.

**Coverage map.** Add rows to the AGENTS.md perf-guard coverage map for T6's new signature and for
T7. Phase 1 also adds one durable gotcha to AGENTS.md: *never scatter N points into one texel. Blend
serialises it (17-19 ms at 325k); reduce with a gather tree.*

## 14. Phased PR plan

Each row is one PR and one issue key; each ships on its own. Keys are resolved to issue numbers when
the issues are filed (sub-issues of #333 unless noted).

| # | Key | Scope | Depends on | User-visible outcome | Perf entry (before → after) |
|---|---|---|---|---|---|
| 1 | **gpu-reductions** | segment table (S = 1), 16-ary reduction tree + range query (MRT), centering from `segStats`, pyramid box from `segBox`; delete `CentroidReducePass` + the bbox scatter; shared pass helper; T0/T1/T5/T6 | — | 325k tick 45-51 → ~13-17 ms; 1M ~155 → ~50 ms | per tick −2 serialized O(N) point blends, +O(N/15) gathers; +0.7 MB |
| 2 | **gpu-float-blend** | `gpuLayoutSupport` (float RT, `texture-blend-float-webgl`, limits, read-format probe, functional probe), fallback with reason and all options, #297 live transport, #311 swap policy, optional `backend: "auto"`; T8 | — | no silent wrong-force layouts on devices without float blend; safe backend swaps; the Navigator can switch to `"auto"` | no per-frame change (checks once per `layout()`) |
| 3 | **gpu-async-readback** | pack pass + staging, PBO ring + fences, harvest into `graph.positions`, budget controller (fence AIMD + timer path), convergence stop on `meanStep` (with §8), `settled` after harvest; T7 | 1 (for the stop) and §8 (schedule); the PBO/budget part stands alone | main thread ~230 → ≤ 3 ms per frame; ~4 → 40-60 fps at 325k; stops at convergence (#124) | +7.8 MB GPU at 325k (0 staging on the RG fast path); −2 × 2.6 MB CPU allocations per frame |
| 4 | **gpu-csr-chunk** | rows ≤ 256 gather unchanged, hub chunk pass + partial gather, `weights` hook (unused on flat), cap removed; T4 | — | hub springs correct (13.5k half-edges restored) | +< 0.1 ms, +< 0.1 MB |
| 5 | **gpu-tile-pyramid** | tile packing, `L0`/`Podd`/`Peven` packed levels (3 samplers), tile-root traversal, softening per segment, segmented exact loop (`exactMax` option); T2/T3 | 1 | none on flat (numerically identical); unlocks segments | +0.96 MB; same pass count |
| 6 | **gpu-ml-seed-plain** | capacity + `setLevel` (one solver), `leafSeed` gather (no per-level readback), seed work in the budgeted loop, coarsening tree from the worker adopted as the LOD tree, schedule seed scale, `multilevel` honoured (#312) | 5, §8 (seed scale), 3 (loop) | plain graphs converge in ~1/3 of the ticks; −244-308 ms main-thread LOD build | peak memory ↓ (no second solver per level); seed levels spread across frames |
| 7 | **gpu-nested** | nested batched solve (segments = parents), two-phase schedule, K-occupant collision, composition passes, warm start + `placeOver`, routing `gpu`/`auto` + `nested`; phase-2 tests | 1, 4, 5, 6 | 1M-leaf nested ≲ 5 s (CPU ~60 s); 325k warm re-cluster ~30 s → ~2 s, animated | new per-tick collision passes (collide phase only); tile atlas ≤ ~47 MB at 336k slots |

Recommended order: 1 → 3 → 5 → 6 → 7. Phases 2 and 4 depend on nothing and can land in parallel
at any point; 2 must land before the Navigator switches to `"auto"`/`"gpu"`.

Issue mapping: gpu-async-readback also **fixes the Milestone-A half of #184** (the issue stays open
for GPU-resident positions) and the GPU part of #124. gpu-float-blend fixes #311 and #297.
gpu-ml-seed-plain fixes #312. gpu-nested fixes #333.

Each PR carries a changeset (patch; `backend: "auto"` is an addition, patch before 1.0), a
`## Performance` section per AGENTS lifecycle §5 (using §10's numbers, re-measured), and docs
updates: `website/src/content/docs/examples/network.mdx` GPU section, the `gpu-transport.ts` header,
and the `NetworkLayoutOptions` JSDoc.

## 15. Open questions (maintainer decisions)

1. **Layout `backend: "auto"`.** Add it in gpu-float-blend (recommended), or have the app pass
   `"gpu"`? When, if ever, should it become the default for `layout({})`?
2. **Pyramid level storage.** Packed levels in 3 textures, pure luma, +4% memory (recommended), or
   one mip texture with raw-GL base/max-level clamps per reduce pass?
3. **#311 swap policy.** Stop and continue warm on the new backend (recommended; needs a flat worker
   warm-start option), or stop only?
4. **GPU budget default.** 10 ms per frame? Should ticks be throttled further while the user
   pans/zooms?
5. **Nested streaming.** One animation of all depths converging together (natural for the batched
   solve), or keep per-depth frames?
6. **Nested parity tolerance.** How far may the Jacobi GPU collision be from the Gauss-Seidel CPU
   reference beyond the invariants?
7. **Coarsening-tree source for the GPU seed.** The worker (recommended, shared with LOD) or the main
   thread? Also: the per-pass timings exist only for M1 Max / ANGLE Metal. Re-measure on at least
   one Intel/AMD/NVIDIA machine before tuning `budgetMs` or `exactMax`.

## 16. Follow-ups (file as issues; do not build here)

- **Sort-based solver**: Morton sort + implicit fan-out-4 LBVH with bbox and maxR. It gives exact
  near-field repulsion and exact collision in one traversal. Consider it if grid-pyramid accuracy on
  clumped graphs (#251) or K-limited collision falls short. Estimated 20-60 ms per full sort at
  1-2M, amortised over 10-20 ticks (unverified).
- **Morton/Hilbert reorder of flat slots**: measured −19% BH, −10% attraction. It uses the §5.1
  permutation with no API change.
- **Merged force pass**: springs + repulsion + centering in one fragment. It would drop the `force`
  texture and its clear, but the pyramid scatter still needs float blending.
- **Async shader compile** (`KHR_parallel_shader_compile`, luma `compilation-status-async-webgl`) to
  hide the construction hitch.

## 17. Related issues

#333 (primitive), #184 (GPU to renderer), #124 (convergence stop), #312 (multilevel on the fallback),
#311 (backend swap), #297 (live transport), #181 (containment), #189 (state layouts), #180 (module
seed), #183 (drag reheat), #251 (near-field softening), #141 (PBO pick readback, pattern reused),
#324/#326/#328 (nested layout, hierarchy, warm start), #106 (N8 epic).
