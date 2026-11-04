---
"@mapequation/d3gl": minor
---

`parseEdgeList` reads node ids the way Infomap does: integers up to 4294967295, with an optional `+` and leading zeros, so `01` and `1` are one node, labelled `"1"`. The new `ids` field gives each node's id; `ParsedEdges` and `ParsedPajek` now always have it. Breaking: a line whose first two columns are not two node ids (a name such as `alice`, `-1`, `2.0`, a missing target; Infomap refuses these too, except that it reads junk in the target column as a weight) throws, naming the line and the token, instead of keeping names as labels or skipping the line.
