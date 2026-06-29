---
"@mapequation/d3gl": minor
---

Align instanced-lane selection styling with retained layers, and add network outgoing-link emphasis (#162):

- **`selection.others` now dims non-selected glyphs on instanced lanes** (network `nodes`, a `plot` layer's decluttered `points`) — the same focus effect retained GeoMap/Plot layers already had, applied as a per-instance alpha multiply. **Default behavior change:** with a selection active, non-selected glyphs now fade to `others.opacity` (default `0.3`) instead of staying full-strength; the selection ring is unchanged. Set `selection: { others: { opacity: 1 } }` to keep the old ring-only look. Lanes honor the opacity component of `others` only.
- **A selected network node keeps its outgoing links at full strength** while the rest dim — so a selection reads as "this node and what it points to" (incident links for undirected graphs; the selected aggregate's outgoing super-edges under LOD). Derived visually from the node selection — `selection()` / `on("select")` stay node-only.
- **Hovering a network node lights up its outgoing links** in the hover colour — the transient link analogue of the hover ring.
