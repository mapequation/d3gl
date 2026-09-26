---
"@mapequation/d3gl": patch
---

The GPU force layout (`layout({ backend: "gpu" })`) stores its Barnes-Hut grid pyramid in three textures instead of one per level. The repulsion pass therefore binds 7 textures instead of 13, well inside WebGL2's guaranteed 16, and it gets slightly faster: about 2% at 325k nodes (9.7 → 9.5 ms per tick on an M1 Max) and about 0.7% at 1M. Layouts are unchanged: on web-NotreDame (325k nodes) and on a 1M-node graph every node's force is bit-for-bit what it was before. The pyramid of a graph above 4,096 nodes takes about 4% more GPU memory (+0.96 MB at 325k nodes and above). Graphs of 4,096 nodes or fewer no longer allocate a pyramid at all, because they use the exact repulsion loop. Internally the solver now supports segments: groups of nodes that repel, attract and centre only among themselves, each with its own tile of the pyramid. This is groundwork for the GPU nested layout (#333).
