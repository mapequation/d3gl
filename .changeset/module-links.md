---
"@mapequation/d3gl": patch
---

Network LOD: `net.lod({ modules, moduleLinks })` accepts **module-level links addressed by Infomap path** (#199) and sums them into the map's super-edges, alongside those derived from the graph's edges.

An Infomap `.ftree` stores leaf links only inside bottom modules and every coarser link only in aggregate, once per level in its `*Links` sections. Consumers previously had to invent leaf edges to get those links drawn; now they pass the rows directly (`{ source: [1, 1], target: [1, 2], flow }`), and each contributes exactly at its own level — no leaf-level edges are derived from it. Endpoints may be modules or leaves (ragged trees mix both). `buildModuleLODTree(nodeCount, records, edges?, links?)` takes the same list; the `ModuleLink` type is exported. Changing `modules` or `moduleLinks` on a later `lod()` call now rebuilds the retained module tree.
