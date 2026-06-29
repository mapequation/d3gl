---
"@mapequation/d3gl": patch
---

Fix: correct aggregate leaf-count on worker-streamed LOD trees (#105). Backfilled changeset; shipped in #156 (`01831b3`).

The per-aggregate leaf count (used for frontier label badges and `members()` sizing) was miscomputed on the worker-built/streamed LOD tree; it now matches the main-thread tree.
