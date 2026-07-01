---
"@mapequation/d3gl": minor
---

Align instanced-lane selection styling with retained layers, add shader-driven network highlight, and harden the marquee gesture (#162):

- **`selection.others` now dims non-selected glyphs on instanced lanes** (network `nodes`, a `plot` layer's decluttered `points`) — the same focus effect retained GeoMap/Plot layers had. **Default behavior change:** with a selection active, non-selected glyphs fade to `others.opacity` (default `0.3`); opt out with `selection: { others: { opacity: 1 } }`.
- **A selected network node keeps its outgoing links at full strength** while the rest dim ("this node and what it points to"; incident links for undirected graphs; the selected aggregate's outgoing super-edges under LOD). Selection highlight is **ancestor-aware** under LOD: zooming into a selected module keeps its expanding children highlighted, while `selection()` / `on("select")` stay node-only.
- **Hovering a network node recolours its outgoing links** toward the highlight colour (luminance-preserving, so weight-encoded links keep their cue), and **highlight colours are now red** (selection + hover rings *and* the link recolour; the subtract-marquee "will remove" ring is yellow; the marquee +/− badge is neutral gray).
- **The network highlight is applied in the GPU vertex shader** (per-instance `group`/`selected` columns + uniforms), so a hover/selection restyle is a uniform change — no per-frame geometry rebuild or buffer re-upload, even on a full **LOD-off** draw of a million nodes. Adds **`interactive({ hoverDimOthers })`** — opt-in fade-others-on-hover, the hover analogue of `selection.others`.
- **Marquee robustness:** the shift+drag box + mode badge are one reused overlay pair, torn down on any interruption (context menu, pointer cancel, window blur, **Esc**) — fixing duplicate badges accumulating on a ctrl-click context menu mid-drag.
