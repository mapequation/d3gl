---
"@mapequation/d3gl": minor
---

`network()` pixel-exact GPU-readback link/glyph picking (#141). Backfilled changeset; shipped in #158 (`afdcf44`).

Opt in with **`net.pickLinks()`**: hover/click then resolve thin links / bent half-arrows / module super-edges that the CPU circle picker can't hit, via a backend pick FBO (`Backend.pickInstanced`, clean-room). A link hit is a `HoverHit` with `layer: "links"` and a `NetworkLinkHit` datum (`{ source, target, weight, aggregate }`). Nodes are drawn on top, so they win where they overlap. Off by default — a non-interactive network pays nothing.
