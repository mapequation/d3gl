---
"@mapequation/d3gl": patch
---

network: `layout({ fit: true })` frames a streaming layout as it converges. For the `worker`/`gpu`
backends the camera is fit to the layout's live bounds each streamed frame (centroid → view centre,
extent → ~85% of the view) and released to normal zoom/pan once it settles or the user interacts.
Without it a streaming layout renders wherever the solver centres it — the GPU solve centres the
centroid at the origin, so it would otherwise appear at the top-left corner until it settled. The
per-frame reframe is fling-out-robust — it frames the top modules' centroids padded by the median
module size (O(top-level modules), not O(nodes)), so a stray flung node can't blow the frame up. The
map-of-modules example uses it (and gains a Nodes slider, 500 → 20,000), so it opens framed and
converges in place instead of piling at the origin and snapping into view.

Also: swapping a network's graph (e.g. a node-count slider) no longer throws
`flowBorder.flow length … !== nodeCount …` — `data()` now drops per-node style arrays sized to the
previous graph, so the idiomatic `data(g).style(s)` re-render works across a resize.
