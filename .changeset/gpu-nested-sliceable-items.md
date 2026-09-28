---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu", nested })` sizes every frame's estimated layout GPU work to its budget, at
1,000,000 leaves and at 120 Hz too (#382). Two pieces of a streamed tick could not be split before: the
prep of a compact tick's first collision step (predict, springs, integrate, the reductions, the collision
cells and its 23 occupancy scatters) and the composition that a frame reading positions back ran before its
copy, so such a frame queued them whole whatever its budget.

- Every pass of a tick is now a work item cut into bands sized to the budget — the reductions, the tile
  pyramid, predict, the springs and integrate, the collision cells, each table's count and occupancy rounds
  (scatters cut into ranges of the binned slots), the collision's work items and its resolve (both cut at
  equal shares of their estimated work) — and so is each pass of the composition, which runs as work items
  of its own before the copy, with no tick in between.
- Every frame's *estimated* layout GPU work stays within the budget, copy frames included (asserted from
  the plans of 1M- and 325k-leaf maps and of large power-law modules at 60 and 120 Hz; the streaming guards
  check that the real transport admits its items by the same sums). The estimates are measured per pass on
  the real GPU, not bounds: a busy GPU runs over them by as much as its passes do.
- The frame budget's controller works with such mixed items: it grows a pass's bands only while each band
  carries its fixed cost in work, halves the growth back only when two bands of a pass keep up, acts only on
  evidence about its current growth (a miss never raises the item count), and a late frame of one band that
  cannot be cut finer no longer throttles every other pass to one item per frame. A readback's repaint
  cadence is timed from its start, so a composition that waits for budget does not delay the repaint.
- A cold nested layout takes longer below 1,000,000 leaves: each frame now holds only the work its budget
  admits by the passes' measured costs (the previous pacing let a frame carry about twice its budget), and
  each band of a cut pass pays its pass's setup again. On an M1 Max: 14-84% longer, most on small maps and
  power-law modules at 120 Hz (a 60,000-child module 1.3 s → 2.5 s, web-NotreDame's trees 2.0-2.4 s →
  2.3-3.2 s); 1,000,000 leaves about the same (4.6-5.0 s → 4.4-4.7 s).
- The layout is bitwise the same for any slicing. The flat layout's positions are unchanged, and its
  multilevel seed, convergence stop, LOD relay and swap state work as before.
- The composition has its own reduction scratch and sums: 3.3 MB more GPU memory at 1M leaves (1.1 MB at
  325k), freed at settle.
