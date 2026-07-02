---
"@mapequation/d3gl": patch
---

Render **state (higher-order / memory) networks** with `network()` (#171). `buildStateGraph({ stateCount, stateToPhysical, source, target })` assembles a state network and derives its physical network (physical nodes = distinct physical ids; links = state edges aggregated across the physical boundary, directed + flow-summed). `net.stateNetwork(graph, { modules })` ingests it and `net.view("state" | "physical")` toggles two renderings of the same data:

- **physical** — the aggregated physical network, where a physical node whose state nodes span ≥2 modules draws as a **pie-chart glyph** (a wedge per module, sized by that module's flow, module-coloured) and a single-module node as a solid disc;
- **state** — every state node on a golden-angle **rosette** around its physical node, coloured by module.

The pie is a new instanced glyph (one GPU instance per wedge — an angular sector of a disc, no wedge texture or per-fragment loop; updates in place) that also traces as filled arc sectors for Canvas/SVG and `toSVG()`, rendering identically across all three backends. New helpers: `rosettePositions` (deterministic state-node placement) and `physicalPieWedges` (overlapping-module → wedge derivation, colours matching `moduleColors`). Positions in this release come from the in-library force layout of the physical graph plus the rosette (a CPU path); the module-aware GPU `stateLayout` is a separate change.
