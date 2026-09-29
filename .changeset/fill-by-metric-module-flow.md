---
"@mapequation/d3gl": patch
---
network: `nodeFill: { by, scale }` colours nodes by a metric (`"degree"` | `"strength"` | `"flow"` | accessor) through a colour scale, like `nodeRadius`'s `{ by, scale }`; an LOD aggregate is filled with the scale on its summed metric, so a module reads as its total flow. `flowBorder.moduleFlow: (path) => number | undefined` gives the modules of the engine's hierarchy their own enter/exit flow, by Infomap path, instead of their members' sum. A `flowBorder.color` accessor now gets the value an aggregate's ring draws (index `-1`), and under LOD a glyph's ring colour is looked up by its own node, not by its position in the frontier.
