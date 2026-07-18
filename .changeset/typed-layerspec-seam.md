---
"@mapequation/d3gl": patch
---

Type the map `LayerSpec` seam so a layer's datum type flows from registration to every
consumer-facing callback (#221). `select(name, predicate)` and `tooltip`/`hover`/`fill`/
`stroke` no longer hand you `any`: `select` gains a datum-typed predicate overload (and a
new datum-inferred `LayerHandle.select`), and the generic `LayerSpec<D>`/`PassThroughSpec<D>`/
`InstancedLaneEntry<D>` bind `data: D[]` to their accessors. `GeoMap.layer` is now typed
`F extends GeoInput` (the GeoJSON you draw). Pure types — no runtime behavior change.
