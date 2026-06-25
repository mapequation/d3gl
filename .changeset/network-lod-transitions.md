---
"@mapequation/d3gl": minor
---

Two opt-in LOD level-transition options on `lod({ … })`, both **off by default with no added cost when unset**:

- **`crossLevelEdges`** (#139): also draw super-edges between **mixed-level** visible nodes — a visible leaf (or finer aggregate) and a visible *coarser* aggregate at a different cut level. The off-frontier on-screen endpoint is projected to its nearest present ancestor (an `O(depth)` walk), so an aggregate keeps its links when you expand a neighbouring region instead of losing them until both sides are at the same level. Applies wherever the directed super-edge CSR exists (module and coarsening LOD trees).
- **`crossFade`** (#133): an opacity **cross-fade** across the expand threshold. Over a band whose half-width is `crossFade` × `expandPx`, an aggregate eases out (smoothstep) as its children ease in, so a split/merge reads smoothly instead of popping. The per-node alpha flows through the frontier glyphs' fill and border, the aggregate halo rings, and the super-edges (faded by their least-visible endpoint), and blends on every backend. During the fade a child **ignores its ancestor as a declutter occluder** — so a fading parent doesn't cull the children emerging behind it — while children still declutter normally against their siblings, keeping the split/merge smooth without a blank moment.
