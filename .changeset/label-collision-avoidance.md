---
"@mapequation/d3gl": patch
---

Labels no longer overprint in dense regions. `network.labels()` now measures each label's text (once
per distinct string, never per frame) and gives it a real, centred collision box, so overlapping
labels are rejected instead of stacking — the survivor of each cluster is the most important one
(`importanceOf`, defaulting to the LOD tree's `weight` with LOD on and node strength with it off).

Placement itself is now grid-backed: placed boxes go into a uniform screen grid, so each candidate is
only tested against its neighbours. The pass is linear in the labels currently in view instead of
quadratic, and it reuses retained buffers rather than allocating a geometry object per label per
frame.

New in the `labels` module: a plain (un-rotated) label can declare where its anchor sits inside the
box — `textAnchor` (now honoured by plain labels too, not just oriented ones) and `baseline`
(`"top" | "middle"`) — and the library derives the rendered CSS transform, the collision box and the
native-text position from that one declaration. Also exported: `labelTransform`, `labelTextY`,
`labelCullScratch`, `fontRowHeight` and `TextMeasurer`.
