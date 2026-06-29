---
"@mapequation/d3gl": minor
---

`network()` selection/hover ring + `members()` on the instanced lane (#105 N7c-2). Backfilled changeset; shipped in #152 (`96b67b2`).

- `interactive({ selectable, hover })` draws a companion **ring overlay** on selected/hovered nodes and aggregates (instanced glyphs have no Scene drawable to recolor, so styling is a ring rather than a fill change).
- A hit's **`members()`** enumerates the leaf node ids it covers — itself for a leaf, the whole subtree for a collapsed module — exposed on `on("hover" | "click")` hits and every `selection()` entry.
