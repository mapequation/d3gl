---
"@mapequation/d3gl": minor
---

State networks are always directed. `buildStateGraph` builds directed state, physical and lumped graphs, so a state
network's links and module links draw with arrows (or half-arrows) in every view. The `directed` option of
`buildStateGraph` is removed: drop it from your calls. A state node's links are its out-links, with flow per
direction, even when the source file says `*Links undirected` (Infomap writes that into a state network's `.ftree`
when it runs without `--directed`). To draw a state network without arrows, set `style({ directed: false })`.
