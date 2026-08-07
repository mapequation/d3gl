---
"@mapequation/d3gl": patch
---

Tests only: geo's per-frame draw path is now guarded on all three backends. Adds a WebGL leg (the
default backend) and an SVG leg, and raises the always-on Canvas leg from ~15k to 50k polygons. No
library behaviour changes.
