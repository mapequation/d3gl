---
"@mapequation/d3gl": minor
---

Align instanced-lane selection styling with retained layers, add network outgoing-link emphasis, and harden the marquee gesture (#162):

- **`selection.others` now dims non-selected glyphs on instanced lanes** (network `nodes`, a `plot` layer's decluttered `points`) — the same focus effect retained GeoMap/Plot layers had, as a per-instance alpha multiply. **Default behavior change:** with a selection active, non-selected glyphs now fade to `others.opacity` (default `0.3`) instead of staying full-strength; the selection ring is unchanged. Set `selection: { others: { opacity: 1 } }` to keep the old ring-only look. Lanes honor the opacity component of `others` only.
- **A selected network node keeps its outgoing links at full strength** while the rest dim — so a selection reads as "this node and what it points to" (incident links for undirected graphs; the selected aggregate's outgoing super-edges under LOD). Selection highlight is **ancestor-aware** under LOD: zooming into a selected module keeps its expanding children (and their links) highlighted, while the selection set stays compact (`selection()` / `on("select")` remain node-only).
- **Hovering a network node highlights its outgoing links** by recolouring the *already-rendered* link geometry toward the hover colour (a lightness-preserving HCL hue shift, so weight-encoded links keep their weight cue) — no parallel geometry, correct bend / half-arrow / width / direction.
- **Marquee robustness:** the shift+drag selection box + mode badge are now one reused overlay pair, torn down on any interruption (context menu, pointer cancel, window blur, Esc) — fixing duplicate badges that could accumulate when a gesture was interrupted (e.g. a ctrl-click context menu). Esc cancels an in-flight marquee.
