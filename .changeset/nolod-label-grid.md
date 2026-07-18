---
"@mapequation/d3gl": patch
---

Network labels with LOD off no longer scan every node on each pan/zoom frame: on settled positions, in-view label candidates are queried from a coarse uniform grid (built at most once per position change), making the per-frame cost O(visible) instead of O(all nodes); a capped `labels({ max })` selection now uses an exact lazy top-k instead of a full sort. Placed labels are identical to before.
