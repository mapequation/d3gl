---
"@mapequation/d3gl": patch
---

The WebGL instanced lanes (network nodes and links, pie wedges, arrows) now grow their GPU buffers by at
least doubling. Under LOD the drawn frontier grows while a layout spreads or a zoom deepens. Before, every
frame that drew a new maximum reallocated all of the lane's buffers (8 per lane). A frontier that grows
fourfold now reallocates twice, and shrinking and growing back within the room reallocates nothing. A lane
that grew keeps room for up to twice the largest frontier it drew. A lane that never grows, such as a LOD-off
graph, keeps its exact size.
