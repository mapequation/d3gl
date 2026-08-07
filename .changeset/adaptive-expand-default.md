---
"@mapequation/d3gl": patch
---

Network LOD: the expand threshold now **adapts to the tree it cuts**, so `net.lod({ modules })` with no `expandPx` opens on a *map of modules* instead of raw nodes.

`expandPx` is an absolute on-screen size, but the footprint it is compared against scales with how many leaves the finest aggregate holds — 2 for a structural coarsening tree (7–23px across at a fit view), 30–60 for a provided module partition (96–123px). The fixed 48px default therefore did real work on the first and nothing on the second. The default is now `48·√(c/2)` for a tree whose finest aggregates hold `c` children, clamped to `[48px, half the shorter viewport side]`: coarsening trees and spatial quadtrees keep exactly the previous 48px, while a module partition gets a module-sized threshold (~190–280px).

Passing an explicit `expandPx` is unchanged — it still means an absolute aggregate diameter in pixels. `defaultExpandPx(tree, width, height)` is exported for callers driving `cut()` directly.
