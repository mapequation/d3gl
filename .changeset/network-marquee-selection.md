---
"@mapequation/d3gl": minor
---

`network()` shift+drag marquee selection (#159). Backfilled changeset; shipped in #160 (`36d71b4`).

On a multi-selectable lane, **shift+drag** draws a box that adds every node/aggregate whose centre falls inside it to the selection (additive, like shift+click), with a live hover-ring preview of what releasing will select. A CPU range query over the screen-bounded frontier (`pickRegion`), so it stays cheap at millions of nodes; plain drag still pans.
