---
"@mapequation/d3gl": patch
---

Fix the view jumping on the first gesture after a programmatic `setTransform`. `enableZoom` seeds
d3-zoom's internal transform once, at call time, so any later programmatic view change (a fit, a
zoom-to-region, a centering translate) left the gesture measuring its delta from the stale seed —
the camera visibly snapped back before zooming. `setTransform` now carries d3-zoom with it.
Consumers no longer need to re-call `enableZoom()` after a programmatic fit.
