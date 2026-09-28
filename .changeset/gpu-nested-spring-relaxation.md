---
"@mapequation/d3gl": patch
---

The GPU nested layout (#355) keeps its springs stable at hubs. It applies all of a module child's springs at once, where the CPU layout applies them one by one, so a child linked to many siblings that takes most of each link's pull could overshoot: a small, low-flow hub page in a directed Infomap tree, for example. On web-NotreDame's directed tree the solve went non-finite, and `backend: "gpu"` or `"auto"` fell back to the worker with a warning. On milder hubs it stayed finite but lost the arrangement, with linked siblings pushed apart. Each child's springs are now relaxed just enough to keep every step stable (only children past the bound change), from static data and at no per-frame cost. web-NotreDame's directed tree now lays out on the GPU: 4.1-4.4 s from the layout call to settled in the Network Navigator on an Apple M1 Max, against 8.9 s on the worker.
