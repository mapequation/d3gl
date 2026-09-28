---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu" })` now stops once the layout has converged, by the same rule as the `worker` and
`force` backends (#124, #376): the mean node step falls below 6% of the equilibrium spacing and is not
growing, at least 30 ticks into the heat schedule. `iterations` is a cap on the GPU backend too, and
`whenSettled()` resolves at the stop, once the stop tick's positions are on screen. A drag's re-cool also
stops at convergence (at most 120 ticks), and a drag itself never stops, as on the worker.

The GPU decides the stop itself, once per tick, so the tick it stops at does not depend on the frame rate,
the GPU budget or when positions are read back: the same graph stops at the same tick with the same
positions every run. Ticks the transport queues before it reads the stop back leave the layout unchanged.
A layout that goes non-finite is frozen on the GPU at once, in addition to the existing warning and stop.

A graph with a module hierarchy (`data(graph, { modules })` or `lod({ modules })`) is seeded over its
modules on the GPU and cools, so it stops like the worker's multilevel run. A plain graph still starts cold
on the GPU (an equilibrium disc at full heat); a multilevel seed for plain graphs on the GPU is a separate
change. A cold start on a large graph can keep moving for longer than the default budget, so the network
example keeps its size-scaled budget for GPU runs.
