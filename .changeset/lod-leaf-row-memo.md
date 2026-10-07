---
"@mapequation/d3gl": patch
---

LOD, spatial source: a held view or a pan answers each kept leaf's super-edge row from the row memo again (#463).
Since the links between two kept leaves were left to the full-detail path (#447), a kept leaf's row was rebuilt from
its graph edges on every frame, which made a pan of a 1M-node view of half leaves and half aggregates 1.4-1.6× the
cost on `main`. The row now records which neighbours were kept leaves when it was built, and is reused while they
still are and its covers still hold. The row memo is also compacted only once a quarter of it is stale, instead of on
every frame whose rows outgrow its bound (at 1M nodes, every frame copied the whole arena).
