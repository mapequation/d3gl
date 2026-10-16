---
"@mapequation/d3gl": patch
---
`network.labels({ maxWidth })`: draw a long label trimmed to `maxWidth` screen px with an ellipsis, place on the trimmed box, and show the hovered glyph's label in full (with `interactive({ hover: true })`, on every backend). Unset, labels are drawn in full as before. Exports `trimToWidth`, `ELLIPSIS` and `TextMeasurer.trim` from `@mapequation/d3gl/labels`.
