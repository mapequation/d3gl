# N8 — GPU force layout: module-aware + state-network capable

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation
**Issue:** #106 (epic #98) · depends on N3 (#101), N4 (#102), N5/N6 hierarchy (#103/#104)

A GPU Barnes-Hut force-layout backend for `network()`, selected via
`layout({ backend: "gpu" })`. Beyond raw speed it is **module-aware** (multilevel
layout over the same hierarchy the LOD renders, top modules down for a good
global map) and **state-network capable** (state nodes grouped within physical
nodes; links state↔state or aggregated physical↔physical). One hierarchy spine
drives layout, LOD, and grouping; one soft-containment force subsumes both
module coherence and the state-node placement modes.

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
  — no renderer/LOD API changes for consumers (Milestone A).
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

### 3. Multilevel schedule

```
seed coarsest level (small)  →  GPU solve to near-rest
  for k = L-1 … 0:
    prolongate(k)   # each child texel fetches parent position + golden-angle jitter (1 GPU gather)
    refine(k)       # N GPU ticks at this level
stream leaf positions each frame (Milestone A: readback; B: sampled in-place)
```

Coarse levels are tiny (cheap); only the leaf solve is heavy, and that is the
GPU's job. The main thread stays free to render each partially-converged frame.

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

**Grouping is not necessarily a single nested tree.** Standard networks nest
cleanly (`modules ⊃ physical ⊃ state`), but Infomap **memory networks** partition
*state nodes* into modules while physical grouping is an *orthogonal* partition
(a module spans several physical nodes; a physical node's states span several
modules). So containment supports:
- a **primary tree** (drives the multilevel solve, prolongation, and LOD), and
- zero or more **additional soft groupings** (a `parent map + γ`, contributing
  only a centroid-pull, no multilevel level).

Nested case → one tree, no extras. Memory case → module tree primary + physical
grouping as an additional soft grouping. *(This is the main point to confirm on
spec review — see Open questions.)*

### 5. State-node placement modes (one mechanism, three settings)

State nodes are the **leaf level**; each physical node is their parent grouping.
The three modes you asked to toggle are configurations of §4's containment at the
physical↔state level:

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

**State-network input.** A state graph declares, per state node, its physical
node id, plus the state-level edges:

```ts
buildStateGraph({
  stateCount,
  stateToPhysical: Uint32Array, // length stateCount → physical id
  source, target, weight,       // state-level edges
  // physical↔physical super-edges are derived by aggregating state edges across
  // physical boundaries (or provided directly), and become the level-1 edge list
});
```

The physical level is inserted as `LODTopology` level 1 (`parent[state] =
physicalGlobalId`); modules (if provided) sit above per §4.

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
- **N8.4** State networks: `buildStateGraph`, physical level, `stateLayout`
  modes; additional-grouping support for the memory-network case.
- **N8.5** Node-drag (#140) parity on the GPU path (pinned flag in integrate).
- **N8.6** Milestone B: GPU-resident positions — instanced lane samples the
  position texture; throttled async readback for CPU LOD/pick/declutter.
- **N8.7** Website example wiring (backend toggle, `stateLayout` control) + docs.

## Open questions (confirm on review)

1. **Grouping model for memory networks** (§4): primary module-tree +
   orthogonal physical soft-grouping — is the flat/overlapping memory case
   in-scope for the first build, or do we ship the clean nested case
   (`modules ⊃ physical ⊃ state`) first and add orthogonal groupings later?
2. **Physical super-edges**: derive by aggregating state edges across physical
   boundaries, or require the app to supply them?
3. **`stateLayout` default**: `"rosette"` (deterministic, cheapest) confirmed as
   the default, with `"force"`/`"two-phase"` opt-in.

## Non-goals

- No clustering / community detection in d3gl (module tree stays app-side /
  Infomap; clean-room GPU implementation, cosmos.gl is conceptual reference
  only — no copied code).
- No streaming-append into a running layout (epic non-goal).
- Milestone B's full GPU LOD-cut/picking (positions resident *and* cut on GPU,
  #141) is a later follow-up, not this build.

## Related issues

#106 (this), epic #98, #101 (N3 contract), #102 (N4 CPU worker), #103/#104
(N5/N6 hierarchy + `LODTopology`), #108 (shared instanced lane — Milestone B),
#140 (node-drag), #141 (GPU-readback picking), #75 (GPU shader projection),
#88 (lazy FBO allocation).
