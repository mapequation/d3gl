---
"@mapequation/d3gl": patch
---

Fix `RangeError: Map maximum size exceeded` when building LOD super-edges on large networks. The
super-edge build accumulated directed flow in a JS `Map` keyed by `a * size + b`; V8 caps a `Map` at
2²⁴ entries, so a hierarchy with more distinct ancestor pairs than that (reached at ~500k nodes with
1M edges — not only at 1M nodes) threw before LOD could render a single frame. It now aggregates with
a flat typed-array counting sort, mirroring `coarsenLevel`: no hashing, no boxing, no entry ceiling.
Also 5–10× faster and lower-memory below the old ceiling, so LOD initialisation on large graphs is
markedly quicker.
