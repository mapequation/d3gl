---
"@mapequation/d3gl": patch
---

network: `style({ linkStyle: "none" })` renders a network as **nodes only**. It is a skip, not a hide — the links, arrowheads and LOD super-edge layers are never built, never coloured and never uploaded, so turning links off on a large graph saves work instead of paying for an invisible buffer. A **constant** `linkWidth: 0` takes the same path (a width *scale* that reaches 0 does not). Purely visual: the edges still drive the force layout and the LOD hierarchy, so toggling links never re-lays-out the graph. Works with LOD on or off and on all three backends. The large-scale network example's **Edges** toggle is wired to it, so "Off" now removes *all* edges rather than only LOD super-edges.
