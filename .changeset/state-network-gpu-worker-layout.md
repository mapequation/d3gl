---
"@mapequation/d3gl": patch
---

network: state networks (`stateNetwork()`) can now run their physical layout on the `worker` or `gpu` backend, not just `force` — `layout({ backend: "worker" | "gpu" })` lays out the physical graph off-thread / on the GPU and re-derives the rosette state positions from it each streamed frame, so the state/both views converge live alongside the physical layout. Tier 1 of #182 (rosette + GPU/worker backend); `force`/`two-phase` module-aware modes are deferred to #189.
