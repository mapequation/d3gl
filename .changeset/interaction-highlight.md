---
"@mapequation/d3gl": minor
---

Interactive styling for retained layers: `on("click")` (drag-suppressed), hover
highlight via per-item overlay (`hover` layer option / `highlight()`, with custom
draw through `HighlightBuilder`), core tooltips (`tooltip` option + `tooltipClass`),
click selection with complement dimming (`selection` option + `select()`), per-drawable
style overrides (`setStyle`/`clearStyle`) on a new styles-only backend path
(`updateLayerStyles`), faster `recolor()`, and clip-aware picking (`clipTo` layers no
longer hit where they are visibly clipped away).
