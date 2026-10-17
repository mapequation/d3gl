---
"@mapequation/d3gl": patch
---
A share mode for the flow border (#510): `flowBorder: { share: true, flow: exitFlow }` covers the share of each node's flow that leaves it (its exit flow over the graph's node flow) as a share of its area, so a node whose flow all leaves it is covered entirely and one with half its flow leaving is half covered, whatever its size. LOD aggregates take their summed exit flow over their summed flow, a module with `moduleFlow` its own exit flow over its summed flow, and each state-network view its own graph's node flow. Works on WebGL, Canvas and SVG, with LOD off and on, in both size modes. The absolute mode (`scale`) stays the default. `FlowBorderSpec` is now the union of `FlowBorderAbsolute` and `FlowBorderShare`.
