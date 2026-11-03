---
"@mapequation/d3gl": minor
---

`parsePajek` reads vertex ids the way Infomap does: any non-negative integer up to 4294967295, 0 and gaps included, with a node for each vertex line and each id a link uses. Nodes are indexed in ascending id order (a file numbered 1..N parses as before), and the new `ids` field gives each node's vertex id. Breaking: the `*Vertices` count no longer adds nodes, and a vertex or link line without valid ids throws, naming the line, instead of being skipped or read as node 0. `#` lines are comments in every section.
