---
"@mapequation/d3gl": patch
---

Flat force layouts pull along module links. With `data(graph, { modules, moduleLinks })`, the `force`, `worker`, `gpu` and `auto` layouts now treat each module link as a spring between the centroids of its two endpoints' members, as strong as the leaf links of mean flow it stands for, with every member of a module sharing its pull. A module therefore moves with the modules it is linked to, in the layout run and when you drag it — also on an Infomap `.ftree`, whose links between modules exist only as module links. Without module links nothing changes. Each tick costs one pass up the module tree, one over the module links and one back down (about 11 ms at 1M nodes on the CPU).
