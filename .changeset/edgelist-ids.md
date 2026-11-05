---
"@mapequation/d3gl": minor
---

`parseEdgeList` returns `ids`, each node's integer id, when every label is a plain integer id (`0`, or digits without a leading zero, up to 4294967295): the id Infomap keys the node by, so an app can match Infomap's output to the nodes. Names, and labels such as `01` or `+1`, leave it out; labels stay exact strings. `ids` moves from `ParsedPajek` to `ParsedEdges`. Breaking: a line with a single column throws, naming the line, instead of being skipped.
