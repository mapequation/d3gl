---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu", nested })` sizes every frame's estimated layout GPU work to its budget, at
1,000,000 leaves and at 120 Hz too (#382). Two pieces of a streamed tick could not be split before: the
prep of a compact tick's first collision step (predict, springs, integrate, the reductions, the collision
cells and scatters) and the composition that a frame reading positions back ran before its copy. At 1M
leaves such a frame could queue up to ~17 ms of layout GPU work against a 10 ms budget (5 ms at 120 Hz), so
a pan or zoom frame waited behind it.

- Every pass of a tick is now cut into row bands sized to the budget — the reductions, the tile pyramid,
  predict, the springs and integrate, the collision cells, the count and each occupancy round (scatters
  cut into slot ranges), the gather — and so is each pass of the composition, which runs as work items of
  its own before the copy, with no tick in between.
- Every frame's *estimated* layout GPU work stays within the budget, copy frames included (asserted from
  the plan of a 1M-leaf map at 60 and 120 Hz; the streaming guards check that the real transport admits
  its items by the same sums). The estimates are measured costs, not bounds: a busy GPU runs over them by
  as much as its passes do. One band of the gather cannot be shorter than its longest fragment, a slot that
  loops over its whole module, so past a module of about 12,000 children at 120 Hz (25,000 at 60 Hz) that
  band alone exceeds the budget.
- The frame budget's controller works with such mixed items: it grows a pass's bands only while each band
  carries its fixed cost in work, halves the growth back only when two bands of a pass keep up, acts only
  on evidence about its current growth (a miss never raises the item count), and a late frame of one band
  that cannot be cut finer no longer throttles every other pass to one item per frame. On the real GPU the
  growth returns to 1 within 1-2 s of a run of GPU stalls, at 60 and 120 Hz. A readback's repaint cadence
  is timed from its start, so a composition that waits for budget does not delay the repaint.
- The layout is bitwise the same for any slicing, and bitwise the same as before (checked on the real GPU
  at 100k, 325k and 1M leaves; the composition too). The flat layout's positions are bitwise unchanged.
- Cost (M1 Max, cold layouts, 60 / 120 Hz): the synthetic 1M-leaf map takes 9% less at 60 Hz and 10% more
  at 120 Hz; the 325k maps and web-NotreDame's multilevel tree are within ±8%; web-NotreDame's two-level
  tree (one 8,528-child module) takes 8% more at 60 Hz and 31-39% more at 120 Hz; a map with one
  60,000-child power-law module takes 12-36% more, with its worst frames' GPU work cut from ~350 ms to
  ~170 ms; small maps (20k-100k leaves) take 22-36% more at 60 Hz and 36-70% more at 120 Hz, where the
  passes' fixed costs bind and the old frames ran up to twice over their budget. A frame now holds only
  what its budget admits. The composition has its own reduction scratch and sums, 3.3 MB more GPU memory
  at 1M (1.1 MB at 325k), freed at settle.
