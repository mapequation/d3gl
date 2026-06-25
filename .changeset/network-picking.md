---
"@mapequation/d3gl": minor
---

Add picking to the `network()` engine (#105 N7a): `on("hover" | "click")` now resolve the node — or the aggregate (collapsed module) — under the cursor on the WebGL instanced lane, which the Scene hit index can't see.

- **CPU hit-test over the LOD cut frontier**: `pick(x, y)` tests the on-screen frontier glyphs as exact circles, or the full node set when LOD is off. Cost is proportional to the *visible* frontier (screen-bounded), never the graph size, so hover/click stay cheap at millions of nodes with no GPU readback.
- **Unified interaction API**: uses the same `on("hover" | "click")` surface as the GeoMap/Plot engines — `network()` overrides only the resolver. On the SVG/Canvas backends, where the frontier is drawn as Scene drawables, picking already flows through the shared Scene hit index.
- **Hit shape**: the `HoverHit`'s `id` is the tree node id (a leaf's id is its original node index; aggregate ids are `≥ leafCount`), and its `datum` is a `NetworkHit` — `{ aggregate, count }` (leaf vs collapsed module, and the leaf count it covers).
