---
"@mapequation/d3gl": patch
---

GPU layout: springs on high-degree nodes are now computed in full (#350).

- `layout({ backend: "gpu" })` used to stop summing a node's springs after 4096 neighbours. The skipped springs still pulled on the neighbours but not on the hub, so the springs' net force was no longer zero. On web-NotreDame this dropped 13,507 springs on its five largest hubs, and after 100 ticks their spring forces were 1.5× to 119× too large in magnitude. Now a node with more than 256 neighbours is summed in chunks of at most 64 by a separate small pass. Every spring counts at any degree, and the hub forces match an exact sum (relative error ≤ 4·10⁻⁵).
- Nodes with at most 256 neighbours (99.5% of web-NotreDame) get bit-identical spring forces. On that graph the spring work takes 0.88 ms instead of 2.07 ms (Apple M1 Max), and a whole tick costs about 0.3 ms (0.7%) more because of the extra pass. A graph with no node above 256 neighbours skips the new pass entirely.
- `buildCSR(nodeCount, source, target, weight?)` can now also return per-entry edge weights (`csr.weights`, parallel to `neighbors`).
