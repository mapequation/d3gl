---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu", nested })` keeps its per-frame GPU budget at 1,000,000 leaves and at 120 Hz
(#382). Two pieces of a streamed tick could not be split before: the prep of a compact tick's first
collision step (predict, springs, integrate, the reductions, the collision cells and scatters) and the
composition that a frame reading positions back ran before its copy. At 1M leaves such a frame could queue
up to ~17 ms of layout GPU work against a 10 ms budget (5 ms at 120 Hz), so a pan or zoom frame waited
behind it.

- Every pass of a tick is now cut into row bands sized to the budget — the reductions, the tile pyramid,
  predict, the springs and integrate, the collision cells, the count and each occupancy round (scatters
  cut into slot ranges), the gather — and so is each pass of the composition, which runs as work items of
  its own before the copy, with no tick in between.
- The estimate of every frame stays within the budget, copy frames included (asserted from the plan of a
  1M-leaf map at 60 and 120 Hz). The gather's bands each wait for its longest fragment, a slot that loops
  over its whole module, so the cost model charges that to every band and sizes those bands to the whole
  budget.
- The layout is bitwise the same for any slicing, and bitwise the same as before (checked on the real GPU
  at 100k, 325k and 1M leaves; the composition too). The flat layout is unchanged: its prep and integrate
  stay whole, and its positions are bitwise equal to before.
- Cost: a 1M-leaf cold layout takes about 5-16% longer (M1 Max, 60 and 120 Hz), because a frame now holds
  only what fits its budget. The composition has its own reduction scratch and sums, 3.3 MB more GPU memory
  at 1M (1.1 MB at 325k), freed at settle.
