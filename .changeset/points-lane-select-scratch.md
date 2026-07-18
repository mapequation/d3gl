---
"@mapequation/d3gl": patch
---

The declutter points-lane `select()` no longer allocates a fresh visible-index array on every zoom/pan frame: it reuses a lazily-grown scratch buffer and returns a subarray view, removing up to ~4 MB/frame of GC churn on large (~1M) plot point layers for smoother continuous zoom. The returned visible set is now valid only until the next select — consumers reading `InstancedLane.visible` must read it fresh and copy if they need a snapshot (all in-repo consumers already do).
