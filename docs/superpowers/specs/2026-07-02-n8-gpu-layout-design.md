# N8 — GPU force layout: module-aware + state-network capable

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation
**Issue:** #106 (epic #98) · depends on N3 (#101), N4 (#102), N5/N6 hierarchy (#103/#104)

A GPU Barnes-Hut force-layout backend for `network()`, selected via
`layout({ backend: "gpu" })`. Beyond raw speed it is **module-aware** (multilevel
layout over the same hierarchy the LOD renders, top modules down for a good
global map) and **state-network capable** (state nodes grouped within physical
nodes; links state↔state or aggregated physical↔physical). One module-tree spine
drives both layout and LOD; one soft-containment force subsumes module coherence
and — via an orthogonal physical grouping — the state-node placement modes.

## Problem

The CPU-worker backend (N4) is **compute-bound, not transport-bound**. Measured
on this machine (V8, the exact `ForceLayout.tick()` path the worker runs), a
100k-node / 600k-edge graph:

- **~200–300 ms per tick**, of which **~175 ms (≈85%) is Barnes-Hut repulsion**
  (`quadtree.applyForce` per node), ~23 ms tree build, ~5 ms edge springs.
- The `network` example computes `iterations = 25` at 100k, so
  `frameEvery = 1` (`worker-transport.ts:90`) — **one tick per streamed frame** →
  **3–4 position updates/sec**, matching the reported lag almost exactly.
- Transport is *not* the bottleneck: SharedArrayBuffer is zero-copy in
  dev/preview; render is GPU-instanced and sub-frame; the worker's post rate is
  gated by tick compute regardless of the main thread.

So the fix must attack the **force computation**. A GPU solve turns each ~200 ms
CPU tick into a few-ms GPU pass, and is the only path toward the epic's
1M–10M targets (where the CPU-worker CSR/compute ceiling is the motivation for
N8 in the first place).

Two capabilities must be designed in from the start (not bolted on):

1. **Module-aware layout.** Today's layout coarsener (heavy-edge matching,
   `coarsen.ts:11`) is *deliberately distinct* from the Infomap module / LOD
   hierarchy. That means the layout does not respect the semantic modules the
   map renders — a module's members can drift and interleave, so an LOD
   aggregate glyph is a possibly-overlapping centroid rather than a coherent
   territory. We want the layout to run over the **module hierarchy** itself.
2. **State networks.** A physical node contains several state nodes (memory /
   higher-order network). We must be able to lay out state nodes clustered
   within their physical node, with links either between state nodes or
   aggregated to physical↔physical super-edges.

## Goal

- 100k lays out at **≥ 30 fps** of streamed convergence (from ~3–4/sec);
  the design scales toward 1M+ without an O(N)-per-frame CPU cost.
- Selected via `layout({ backend: "gpu" })` behind the **N3 pluggable contract**
  — no renderer/LOD API changes for consumers (Milestone A). The **CPU-worker
  backend (N4) stays** as a coexisting option (and the fallback when WebGL2 is
  unavailable); `"gpu"` is added alongside `"worker"`/`"positions"`, not a
  replacement.
- **Module-aware:** multilevel solve over the provided/computed module tree +
  an ongoing **soft containment** force → modules read as coherent regions under
  their aggregate glyphs.
- **State networks:** a `stateLayout` knob — `"rosette"` (default) | `"force"` |
  `"two-phase"` — all configurations of the one containment mechanism.
- Rendered output stays correct on all three backends (positions feed the
  existing instanced lane exactly as the worker backend's do).

## Design

### 1. Unified hierarchy spine

Replace the separate heavy-edge layout coarsener with the **same `LODTopology`**
the renderer already uses (`lod.ts` / `modules.ts`): `parent[]` +
`levelOffset[]` (contiguous id range per level, leaves = level 0) + super-edge
CSR (`edgeOffset`/`edgeNeighbors`). Source via the existing priority chain:

```
provided Infomap module tree (modules.ts)  →  structural coarsening (fallback)  →  flat
```

Because the layout tree *is* the LOD tree, a module's aggregate glyph sits
exactly over its members. `LODTopology` already carries everything a multilevel
solve needs (per-level id ranges + a parent map for prolongation + coarse
adjacency for each level's edge list), so this is a **reuse**, not a new
structure.

```
level L (top modules)   ●            few nodes — solved first (super-edges as its edge list)
                       / \
level 1 (leaf-modules) ●   ●         prolongate + refine
                      /|   |\
level 0 (leaves)     ● ●   ● ●       finest solve — where GPU parallelism replaces the 175 ms CPU tick
```

**Ragged depth + a height-vs-depth misalignment to resolve.** An Infomap module
tree keeps leaves only at the bottom and never mixes a leaf with a module at the
same parent, but **branches reach different depths** — one leaf may sit directly
under a top module, another three modules down. The layout must be navigable
**top-down** (place top modules, descend into children). But the current LOD
tree assigns each module a **level by *height*** (`modules.ts` §3: a module's
level = 1 + its deepest child's height, so `computeLODPositions` can aggregate
**bottom-up** by level). Height-levels and depth disagree on a ragged tree — a
"height-2 level" mixes a top module of a shallow branch with a mid module of a
deep branch — so a layout that iterates height-levels (as today's `multilevelSeed`
does) would solve the wrong units.

**Resolution:** the module-aware layout traverses the **tree structure**
(`parent`/`children` CSR) **top-down by depth**, and defines a **leaf structurally**
(no children), *not* as "level 0". This decouples the layout from the height-based
level assignment entirely: prolongation is per-parent→children, so ragged depth is
handled by recursion (a shallow-branch leaf is placed as soon as its parent is,
and never subdivided). There is **no second "module position" to reconcile**: an
aggregate's rendered position is simply the **centroid of its members**
(`computeLODPositions`, bottom-up), and the soft-containment force (§4) pulls each
node toward that *same* centroid — a cohesion pull that stops a module's members
drifting apart, so the centroid stays a tight, meaningful point under the aggregate
glyph. The top-down placement is only the **seed**; the final aggregate position is
the member centroid, used identically by containment and by rendering. So LOD's
height-based cut and the layout agree on positions without sharing a level numbering.

### 2. GPU data model (renderer's WebGL2 device)

The GPU solve runs on the **main-thread renderer's device**, not an
OffscreenCanvas worker: GPU compute is milliseconds, so there is nothing to hide
from the main thread (the N4 worker existed only to hide the 175 ms CPU tick),
and Milestone B needs to share textures with the render context — a separate
worker context could not.

Per level:
- **Position texture** `RG32F`, one texel per node (ping-ponged for integrate).
- **Velocity texture** `RG32F` (Verlet-ish damping state).
- **Force-pyramid textures**: a stack of `RGBA32F` COM/mass grids at halving
  resolution (`(Σmx, Σmy, Σm, _)`) — the clean-room "quadtree-as-texture-pyramid".
- **Edge list** as index buffers for the attraction pass (super-edges at coarse
  levels, real edges at the leaf level).
- **Parent-id texture** (level→parent map) for prolongation + containment.

Config uniforms: `repulsion, attraction, centering, theta, alpha, damping`, plus
containment strengths `γ(depth)` and `stateLayout` parameters.

### 3. Multilevel schedule — top-down over the tree, then global refine

Two phases, split so the top-down structure sets the global map and the heavy
work stays GPU-parallel:

```
SEED (top-down, structure-driven — resolves the ragged-depth misalignment §1):
  solve root's children (top modules) in the global frame     # super-edges among them as the edge list; small
  BFS the children CSR from the root:
    for each internal module m (in depth order):
      prolongate: seed each child near m's position + golden-angle jitter   # 1 GPU gather via parent-id texture
      (optionally orient m's children toward m's external-link directions — see prior art)
  # a "leaf" is any node with no children — placed when its parent is, never subdivided

REFINE (global, GPU-parallel — the heavy phase):
  tick the whole leaf/frontier set at once: repulsion + attraction + centering + soft containment (§4)
  stream positions each frame (Milestone A: readback; B: sampled in-place)
```

The seed is depth-ordered over the tree (not height-levels), so it places top
modules first and descends — the "good global map". Coarse solves are tiny; the
global refine is the only heavy phase and is exactly where the GPU replaces the
175 ms CPU tick. The main thread stays free to render each partially-converged
frame.

**Prior art (clean-room — ideas only, no copied code).** mapequation.github.io's
`hierarchicalLayout.ts` lays a module tree out **top-down and recursively**: each
module's direct children in a *local* frame (d3-force repulsion + intra-module
links + center), scaled to a **flow-sized disk**, with an **anchored transform**
(rotation ± reflection) orienting a child module's interior toward its external
links to cut cross-boundary crossings — recursing on structure so ragged depth is
free. We borrow the **top-down structure-driven schedule** and the **anchored-
orientation idea** (a future refinement), but *diverge* on the engine: thousands
of tiny per-module CPU sims don't parallelize on the GPU, so refinement is a
**single global soft-containment solve** (the user's chosen module binding), which
achieves comparable module coherence while keeping the GPU busy. Flow-sized module
radii give containment a per-module target radius — a soft analogue of the
reference's disk packing.

### 4. Force formulation — containment is one extra pass

Per tick (all fragment-shader passes over the level's position texture):
1. **Repulsion** — build the force pyramid (mip-style reductions), then per node
   walk coarse→fine, applying the θ opening criterion per pyramid cell (softened
   as in `quadtree.ts`). O(n · log-ish) parallel across all nodes.
2. **Attraction** — spring along each (super-)edge.
3. **Centering** — pull toward the level centroid.
4. **Soft containment** (the module-coherence + grouping term):
   - **Segmented reduction** → each parent's centroid: scatter children into a
     parent accumulation texture with additive blending `(x, y, 1)`, then
     normalize by count. Recursive up the levels.
   - **Pull** each node toward its parent centroid with strength `γ(depth)`.
5. **Integrate** — velocity Verlet-ish damping into the ping-pong FBO
   (respecting a pinned/held flag, mirroring the CPU `pinned` path for drag #140).

**Grouping is orthogonal, not a single nested tree** (confirmed on review). The
Infomap module tree partitions *state nodes*; physical grouping is an
**independent partition** — a module spans several physical nodes, and a physical
node's state nodes can belong to several modules (the "overlapping modules" the
physical view renders, #171). We do **not** assume a nested `modules ⊃ physical ⊃
state` tree. So containment carries:
- a **primary tree** — the module tree over state nodes — driving the multilevel
  solve, prolongation, and LOD, and
- one **orthogonal soft grouping** — physical membership (`stateToPhysical` map +
  `γ`) — contributing a centroid-pull that clusters a physical node's state nodes,
  *without* being a level of the primary tree.

Each grouping contributes a centroid-pull (§4.4); the two coexist because both are
just `(parent/membership map, γ)` inputs to the same containment pass. The
`stateLayout` modes (§5) configure the **physical** grouping specifically.

### 5. State-node placement modes (one mechanism, three settings)

State nodes are the **leaves** of the primary (module) tree; the **physical
grouping is the orthogonal soft grouping** from §4 (`stateToPhysical` + `γ`), not
a tree level. The three modes you asked to toggle are configurations of that
physical-grouping containment:

| `stateLayout` | Configuration | Character |
|---|---|---|
| `"rosette"` (default) | leaf solve OFF; state positions = physical centre + fixed deterministic ring (golden-angle) | deterministic, cheapest, guaranteed containment, no intra-physical structure |
| `"force"` | leaf solve ON with state↔state links + soft `γ` toward physical centroid | shows intra-physical structure; `γ` tunes tight↔loose |
| `"two-phase"` | solve physical level to rest → **pin** physical positions → solve state level locally with `γ` toward the pinned centre | clean scale separation; intra-physical layout ignores global pull |

`"two-phase"` is `"force"` with the physical level pinned during the leaf pass —
a scheduling flag, not a separate solver. `"rosette"` is `γ→∞` with placement
precomputed. So the toggle is one enum over shared code.

### 6. Integration — staged (A → B)

The GPU solve makes positions GPU-resident, but the renderer uploads a
`Float32Array` and CPU LOD-cut / picking / declutter read `cx/cy/extent`.

**Milestone A — readback into today's path (ships first, lowest risk).**
After the leaf integrate pass, read the leaf position texture back to CPU
(async PBO to avoid a pipeline stall) into the existing positions buffer/SAB,
then run the existing `computeLODPositions` on the main thread. Renderer, LOD
cut, and picking are **unchanged** — the GPU backend presents the identical
output interface the worker backend does. Readback (800 KB at 100k) is trivial
next to the eliminated 175 ms. Already ~30–60 fps at 100k.

**Milestone B — GPU-resident positions.** The instanced lane's vertex shader
samples node position from the position texture (`texelFetch` by instance id)
instead of a per-instance attribute; CPU LOD/pick/declutter are fed by a
**throttled** async readback (every K frames / on-settle — they are coarse and
interactive, a few frames of lag is invisible). Removes the per-frame readback
that would bite at 1M+. Touches the shared instanced lane (#108) — a deliberate,
tested change to shared code.

**N3 contract.** Extend the pluggable layout contract with a GPU variant whose
position source is a texture handle (Milestone B); Milestone A reuses the
existing `Float32Array` position-output seam unchanged.

### 7. Public API / data model

```ts
net.layout({
  backend: "gpu",
  iterations,
  force,                                   // repulsion/attraction/centering/theta/alpha
  containment: { strength: 0.15, byDepth },// soft module coherence (§4.4); 0 ⇒ scaffold-only
  stateLayout: "rosette" | "force" | "two-phase",  // §5; default "rosette"
});
```

**State-network input.** A state graph has the same structure as a standard
network plus a **per-state-node physical id**:

```ts
buildStateGraph({
  stateCount,
  stateToPhysical: Uint32Array, // length stateCount → physical id
  source, target, weight,       // state-level edges (same shape as buildGraph)
});
```

The **engine derives the physical network** (confirmed on review): physical nodes
= distinct physical ids; physical↔physical links = state edges aggregated across
physical boundaries (directed, flow-summed) — the same super-edge aggregation the
LOD path already does, applied at the physical boundary. For **layout**,
`stateToPhysical` is the orthogonal soft grouping (§4/§5); the module tree (if
provided) is the primary tree. The **rendering** side — the state↔physical view
toggle and drawing overlapping-module physical nodes as pie charts — is a separate
issue, **#171**, which shares this same `buildStateGraph` / `stateToPhysical`
model.

### 8. Performance

**Per-frame cost (leaf level, N = leaf count of the *visible/solved* set):**
- Repulsion: `O(N · pyramidWalk)` on GPU, fully parallel — replaces the
  `~175 ms`/tick CPU repulsion; expected few-ms at 100k.
- Attraction/centering/containment/integrate: `O(N + E)` GPU passes, few-ms.
- Milestone A readback: `O(N)` GPU→CPU copy (async PBO); 800 KB at 100k, grows
  linearly — the ceiling Milestone B removes for render.
- Main-thread `computeLODPositions`: `O(tree size)` ≈ `O(N)`, unchanged from the
  worker path, few-ms at 100k.

**Memory:** per-level position/velocity textures `O(nodes)` and the force
pyramid `O(nodes)` on the GPU; CSR/topology `O(nodes + edges)` on the CPU
(unchanged). No per-frame allocation on the steady path.

Both **reduction states** must be tested (§9): LOD on (O(visible)) and LOD off
(full detail). GPU buffers are updated in place (ping-pong), never
destroyed+recreated per frame.

### 9. Testing & verification

- **Per-frame budget tests** (mandatory, both LOD on and off): a ≈1M-node input
  through a `setTransform`/streamed-convergence sweep asserts a wall-clock frame
  ceiling; assert readback and buffer updates are in-place (no per-frame
  destroy+recreate, no O(total)-per-frame CPU pass).
- **Convergence quality** (GPU is approximate, not bitwise CPU-equal): assert
  edge-length distribution and planted-community separation on the LFR generator
  are within tolerance of the CPU backend — quality parity, not exact positions.
- **Containment / state modes**: modules stay within their aggregate radius under
  containment; `rosette` state nodes sit on the deterministic ring; `force`/
  `two-phase` keep state nodes within their physical node.
- **Backend rendering equivalence** is unaffected — positions feed the existing
  instanced lane, which the backend-equivalence harness already covers.
- WebGL2 capability probe → **fall back to the CPU-worker backend** where the
  GPU path is unavailable (headless/unsupported), mirroring the worker→sync
  fallback.

## Milestones (sub-issues under #106)

- **N8.1** GPU single-level force core (repulsion pyramid + attraction +
  integrate) on the renderer device; readback into the existing positions path;
  WebGL2 probe + CPU fallback. *(Milestone A skeleton.)*
- **N8.2** Multilevel schedule over `LODTopology` (coarsest→prolongate→refine)
  — unify layout hierarchy with the LOD/module tree.
- **N8.3** Soft containment (segmented-reduction centroid + pull); module
  coherence; `containment` API.
- **N8.4** State networks (layout): `buildStateGraph` + `stateToPhysical`,
  physical as an orthogonal soft grouping, `stateLayout` modes. (Rendering — the
  state/physical toggle + pie-chart glyphs — is **#171**, separate.)
- **N8.5** Node-drag (#140) parity on the GPU path (pinned flag in integrate).
- **N8.6** Milestone B: GPU-resident positions — instanced lane samples the
  position texture; throttled async readback for CPU LOD/pick/declutter.
- **N8.7** Website example wiring (backend toggle, `stateLayout` control) + docs.

## Resolved decisions (from review)

- **CPU-worker backend (N4) coexists** as an option + WebGL2-unavailable fallback.
- **Overlapping / orthogonal grouping** is the assumed case (not nested-first):
  module tree over state nodes = primary; physical = orthogonal soft grouping.
- **Engine derives the physical network** (aggregated super-edges); the app
  supplies only `stateToPhysical`.
- **`stateLayout` default = `"rosette"`** (`"force"`/`"two-phase"` opt-in).
- **State-network *rendering* is split to #171** (physical/state toggle,
  overlapping modules as pie-chart glyphs); this issue owns *layout* only.

## Remaining / empirical (settle during implementation)

- Whether a single **global** soft-containment refine gives enough module
  coherence, or a few **per-module** local GPU passes are worth batching for
  tighter territories (measure on LFR + real Infomap trees).
- **Anchored orientation** (rotate a module's contents toward its external links,
  from the prior-art reference) — deferred refinement, not the first build.
- Milestone B **readback throttling cadence** for CPU LOD/pick (every K frames vs
  movement-triggered).

## Non-goals

- No clustering / community detection in d3gl (module tree stays app-side /
  Infomap; clean-room GPU implementation — cosmos.gl and mapequation's
  `hierarchicalLayout.ts` are conceptual references only, no copied code).
- No streaming-append into a running layout (epic non-goal).
- **State-network rendering** (physical/state toggle, pie-chart overlapping
  modules) is **#171**, not this issue — this is layout only.
- Milestone B's full GPU LOD-cut/picking (positions resident *and* cut on GPU,
  #141) is a later follow-up, not this build.

## Related issues

#106 (this), epic #98, #171 (state-network rendering), #101 (N3 contract),
#102 (N4 CPU worker — coexists/fallback), #103/#104 (N5/N6 hierarchy +
`LODTopology`), #108 (shared instanced lane — Milestone B), #140 (node-drag),
#141 (GPU-readback picking), #75 (GPU shader projection), #88 (lazy FBO
allocation).
