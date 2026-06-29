---
"@mapequation/d3gl": minor
---

`network()` interactive node-drag (#140). Backfilled changeset; shipped in #161 (`b2d31cd`).

- **`interactive({ draggable: true })`** — a plain drag starting on a node moves it instead of panning; it tracks the cursor with no lag while the layout reheats around it and re-cools on release. Grab a selected node to drag the whole selection; grab a collapsed module to drag its whole subtree. Works on the `force` and `worker` layout backends (reheat) and `positions` (translate-only). `ForceLayout.setPinned` holds the dragged set; the worker is kept alive after convergence and reheats via a pin/unpin protocol.
- **Marquee subtract** — hold option/alt while shift+dragging to *remove* the box's glyphs from the selection (red "will-remove" preview ring + a +/− cursor badge); the additive marquee is unchanged.
- **Consistent selection-ring palette** — defaults are now **blue** `#2563eb` (selected), **green** `#16a34a` (hover / will-add), **red** `#dc2626` (will-remove), overridable via `selection.selected.stroke` and a `hover` HighlightStyle's `stroke`. (Changes the previous orange/white defaults.)
