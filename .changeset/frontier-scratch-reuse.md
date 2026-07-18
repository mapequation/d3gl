---
"@mapequation/d3gl": patch
---

Network LOD zoom/pan frames no longer allocate in the visible-set pipeline: `cut()` and `declutterFrontier()` now run on engine-owned, lazily-grown scratch (no boxed frontier/stack arrays, no output copies, no per-frame Float64Array/order/flags churn), and the frontier declutter sorts a typed index array on a flat precomputed key array instead of a boxed-lookup closure comparator. At a ~1M-glyph reductions-ON frontier this removes tens of MB of per-frame garbage and cuts the per-frame cut+declutter time roughly in half, so zoomed-out navigation over dense maps stays smooth.
