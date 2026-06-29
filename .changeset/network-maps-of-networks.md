---
"@mapequation/d3gl": minor
---

`network()` maps of networks (#104 N6) — render a network as a directed map of modules. Backfilled changeset; shipped in #127 (`2a1ed81`), #129 (`3c60fae`), #130 (`c0d7346`), #131 (`82bc507`), #132 (`b9d301a`), #134 (`150284e`), #136 (`7e0afd1`).

- **Provided module hierarchy as an LOD source** — `lod({ modules })` takes an Infomap-style per-node `path` partition; modules collapse to one aggregate glyph (inheriting their module colour) and expand into sub-modules → leaves as you zoom.
- **Flow-border nodes** — `flowBorder: { flow, scale }` rings each node by its enter/exit flow (a darker shade of the node fill by default).
- **Bent half-arrow links** — `linkStyle: "half-arrow"` (directed): one filled shape per link that pinches toward the target, curved by `linkBend` — the map-of-networks link glyph.
- **Directed module super-edges** — under module LOD, half-arrow super-edges between collapsed modules thicken/darken with their accumulated flow.
- **`moduleColors()`** helper for hierarchical categorical palettes, plus the `modular-lod` and `modular-map` examples.
