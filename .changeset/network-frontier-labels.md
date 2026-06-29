---
"@mapequation/d3gl": minor
---

`network()` frontier labels (#105 N7b). Backfilled changeset.

- **`net.labels({ labelOf, max })`** — HTML-overlay labels on the visible LOD frontier, importance-ranked (top-`max` by flow/size), re-placed on pan/zoom with overlap culling. Shipped in #153 (`ef52473`).
- **Backend-native label text + export** — on the SVG/Canvas backends the labels render as real `<text>` / `fillText` rather than the HTML overlay, so `toSVG()` exports publication output with the labels baked in. Shipped in #154 (`f33b985`).
