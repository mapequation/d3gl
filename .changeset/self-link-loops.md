---
"@mapequation/d3gl": patch
---

Self-links are drawn as a loop at their node (#505).

- **One loop per node.** The loop is a drop at the node's rim: it leaves and comes back along two legs aimed at the node's centre, with a round far end, and a directed loop's arrowhead points into the node. It is placed opposite the mean direction of the node's neighbours. Several self-link edges on one node are summed into one loop, whose width, colour and flow come from the summed weight. The placement is a fixed rule, not a style option.
- **Every link style and backend.** Loops follow `linkStyle` (`line`, with an arrowhead when `directed`, and `half-arrow`) and `sizeMode` (world and screen) on WebGL, Canvas and SVG, and in `toSVG()`.
- **Interaction.** Hovering or clicking a loop reports the node's first self-link edge with the summed weight; selection and hover highlight include it.
- **LOD and state networks.** With LOD on, drawn leaf nodes keep their loops and aggregates draw none. In a state network the state view and the both view draw loops.
- **Cost.** A graph without self-links pays one scan of its edges per graph and nothing per frame.
