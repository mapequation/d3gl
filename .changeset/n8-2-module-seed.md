---
"@mapequation/d3gl": patch
---

network: module-aware GPU layout seed (N8.2). When a module hierarchy is provided
(`lod({ modules })` before `layout({ backend: "gpu" })`), the GPU force layout now seeds
**top-down over the module tree** instead of a plain disc, so modules lay out as coherent
regions. The seed traverses the tree by **depth** (deriving depth from the parent map, so
ragged hierarchies — branches of different depths — are handled by construction), and every
per-level step is GPU-parallel and O(level size): a golden-angle **prolongation gather** places
each level's children around their parent, then a GPU force solve (repulsion pyramid +
super-edge attraction + centering) refines each level over its inter-module super-edges. Levels
larger than a bound are prolongated without a solve to keep the one-time seed cheap; the finest
refine (real edges) polishes. Falls back to the disc seed for module-less / edge-less graphs.
The `network` and state-network examples now default their **Backend** control to GPU.
