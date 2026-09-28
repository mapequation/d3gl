---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu" })` now seeds plain graphs with a multilevel seed, as the CPU backends do (#353,
#312). A layout worker coarsens the graph (the same heavy-edge matching as the worker backend's seed and
the LOD tree) while the GPU solver is built, and the GPU lays out every coarse level on that one solver,
coarsest first, with each coarse node weighing the nodes it stands for, so every level sits at the final
layout's scale. The levels run inside the streamed frame loop under the same GPU and main-thread budget
as the refinement, and nothing is read back until the nodes are placed. Until that first frame the
equilibrium-sized disc stays on screen. With LOD on, the LOD worker's one coarsening builds both the seed
and the tree.

`multilevel: false` starts the GPU layout from the disc. This now also applies when a module hierarchy is
provided: the module-aware GPU seed used to run whatever `multilevel` said.

On web-NotreDame (325,729 nodes, 1.5M edges, M1 Max, Chromium at 120 Hz) the first frame shows the seed
0.8 s later than the disc start's first frame (1.34 s instead of 0.54 s after `layout()`), with the global
arrangement already in place: mean edge length 679 instead of 16,682. The seed is paced by animation
frames, so on a 60 Hz display that first frame comes about twice as late (estimated, not measured). The
seeded run meets the CPU layouts' convergence rule at tick 149 (5.7 s), with a mean edge of 495. The disc
start never meets it in its 300-tick budget and ends at 586. The seeded run matches the disc start's final
quality after about 25 ticks (2.1 s instead of 10.9 s). The layout never overshoots its final extent.

The module-aware GPU seed (a module hierarchy from `data(graph, { modules })` or `lod({ modules })`) now
runs on the same solver and in the same frame loop, with mass-weighted levels, instead of building one
solver per depth and reading each depth back synchronously. On a 200,000-node, 1,000-module tree the
main-thread long task at `layout()` drops from 460 ms to 242 ms, the first frame comes 574 ms after
`layout()` instead of 462 ms, and modules end slightly less compact after 300 ticks (the ratio of
same-module to cross-module pair distance is 0.221 instead of 0.194).
