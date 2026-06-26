---
"@mapequation/d3gl": minor
---

Decluttered `plot.points()` scatters now render through the shared instanced lane on WebGL (#108-C): draw cost is proportional to the *kept* (post-declutter) set rather than total N — index compaction instead of draw-all-then-hide — so dense decluttered scatters scale much further. The lane is used for `declutter`-enabled point layers with no `clipTo`, `hover`, or `selection` (those keep the Scene path, so `clipTo` stencil, hover-highlight, and selection restyle are unaffected); plain points, vector (SVG/Canvas) backends, and `passThrough` are unchanged. Under `backend:"auto"`, a declutter layer transparently upgrades from the Scene path to the lane once the WebGL backend is live (and downgrades back on a swap). `tooltip` works on lane layers; `append()` on a declutter layer now throws (rebuild with the full data) rather than silently mishandling the captured snapshot.
