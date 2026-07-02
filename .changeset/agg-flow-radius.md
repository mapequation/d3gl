---
"@mapequation/d3gl": patch
---

LOD aggregate glyphs (module/cluster discs) are now sized by their members' summed **flow** by default (falling back to summed **strength**, the weighted degree, when the graph has no flow) instead of the count-based, metric-agnostic `√(Σ child radius²)` fallback (#192). This applies whenever `nodeRadius` doesn't already specify a metric (a constant radius, a caller-supplied `Float32Array`, or a degree-only function) — a higher-flow module now reads visibly larger than a same-count low-flow module. The scale is area-proportional, anchored at the mean leaf radius/value so a leaf's own value maps back to ≈ its own radius. `nodeRadius: { by: "flow" | "degree" | "strength", scale }` is unchanged. Style-time only (computed once per `style()`/data change, baked into the LOD tree) — no per-frame cost.
