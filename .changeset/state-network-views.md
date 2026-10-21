---
"@mapequation/d3gl": patch
---

State networks render and interact correctly in all three views (#494):

- `stateNetwork(graph)` no longer needs `modules`: a raw state network switches views, without pies.
- New `nodeFill: { by: "module", color: (modulePath) => string | undefined }` colours nodes by the module hierarchy the engine holds: `data(graph, { modules })`, or a state network's modules, where it also colours the pie wedges and physical nodes in every view. An LOD aggregate that is a module (a module tree's) takes its own module's colour; a spatial or structural cell keeps its members' colour mean. `color` is asked once per module. A view switch no longer overwrites the app's `nodeFill` or `nodeRadius`.
- The `both` view draws its physical nodes from the first frame (also when `lod()` was asked for in that view, which no longer replaces them), without leaking the both view's radii into the other views. How it sizes its state nodes and physical nodes is in #509's entry.
- In state-network mode `lod()` holds across view switches and applies to the state view only, so an app calls it once: the physical view draws in full, every pie with it, until pies are LOD-aware (#174), and the both view's physical nodes hold every state node.
- New `style({ moduleColor: (modulePath) => string | undefined })`: the app's module palette. A state network's pie wedges and both-view physical nodes always take it, whatever `nodeFill` is (nodes can be filled by flow or metadata while the pies and physical nodes keep the app's module colours), a `nodeFill: { by: "module" }` without its own `color` takes it, and a state network with no `nodeFill` colours its nodes by it. A later `style({ moduleColor })` recolours the pies, uploading their colours alone.
- A physical node as a whole (in the physical view and in the both view) takes its dominant module's colour: the pie wedge holding most of its flow, a tie going to the lower module. It took its first wedge's, the lowest-numbered module, so a node with one small state in a large module took that module's colour. The pies still draw every wedge in module order.
- `both`-view physical nodes hover, select (as their state nodes), drag (with their state nodes) and dim with the highlight (#315).
- A view switch maps the selection (a physical node ↔ its state nodes) and announces it with `select`; it clears the hover (#316).
- In state-network mode, hits, `select` hits and label info carry `level: "state" | "physical"`, and a physical-level hit its `physical` id.
