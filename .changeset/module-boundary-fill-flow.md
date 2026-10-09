---
"@mapequation/d3gl": patch
---

Module boundaries can be styled per module (#471): `lod({ moduleBoundary: { color: "fill", width: (path) => … } })` rings each opened module in the fill it had when collapsed and as wide as the accessor returns for its Infomap path (e.g. the module's enter flow through the flow-border scale; `undefined` keeps the default width). Both are resolved once per module when the style is resolved against the tree, never per frame. The `module-boundaries` layer now draws above the links and below the nodes on every backend, so a dense module's links no longer hide its boundary. `flowBorder.flow` is optional when `moduleFlow` is given, for input with module flow only (an Infomap `.ftree`): nodes then draw no ring, a module draws its own value, and a module without one draws none.
