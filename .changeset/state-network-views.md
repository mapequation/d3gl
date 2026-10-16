---
"@mapequation/d3gl": patch
---

State networks render and interact correctly in all three views (#494):

- `stateNetwork(graph)` no longer needs `modules`: a raw state network switches views, without pies.
- New `nodeFill: { by: "module", color: (modulePath) => string | undefined }` colours nodes by the module hierarchy the engine holds: `data(graph, { modules })`, or a state network's modules, where it also colours the pie wedges and physical discs in every view. `color` is asked once per module. A view switch no longer overwrites the app's `nodeFill` or `nodeRadius`.
- The `both` view draws its containers from the first frame (also when `lod()` was asked for in that view, which no longer replaces them), and sizes its state dots to their containers in world units, without leaking that radius into the other views.
- `both`-view containers hover, select (as their state nodes), drag (with their state nodes) and dim with the highlight (#315).
- A view switch maps the selection (a physical node ↔ its state nodes) and announces it with `select`; it clears the hover (#316).
- In state-network mode, hits, `select` hits and label info carry `level: "state" | "physical"`, and a physical-level hit its `physical` id.
