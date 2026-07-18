---
"@mapequation/d3gl": patch
---

Network LOD zoom/pan frames no longer allocate and zero an O(tree.size) presence array (plus fresh gather arrays and maps) on every super-edge emit. The engine now owns a reusable, generation-stamped scratch, so the per-frame super-edge cost is O(visible frontier + drawn super-edges) — at a 1M-node graph this removes ~2 MB of typed-array churn per navigation frame.
