---
"@mapequation/d3gl": patch
---

Let screen-space `declutter` act on analytic points (`Plot.points`). A lone point's anchor now
defaults to its center, and `points()` accepts a `declutter` option, so a decluttered scatter can
use lightweight GPU points (~4 verts each) instead of tessellated `ctx.arc` paths (tens of verts).
This lifts a decluttered cloud from ~256k (where the path geometry OOMs a tab) to ~1M. Rendering
and screen-mode hit-testing are unchanged (the point shader already culls by the visibility flag,
and hit-testing already used a lone point's center as its anchor).
