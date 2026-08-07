---
"@mapequation/d3gl": patch
---

Add a `curveTolerance` engine option so curves stay smooth when you zoom in.

Curves drawn through a layer's `draw` callback (`arc`, `bezierCurveTo`, `quadraticCurveTo`, and
anything a `d3-shape` generator emits) are flattened to a polyline **once**, at layer registration,
in **world units**. The view transform only scales that baked polyline, so a facet of `t` world
units measures `t·k` screen px at zoom `k` — at the default tolerance of `0.25`, a `k = 40` view
put 14.6% of a disc's ink in the wrong place.

`plot()`, `geoMap()` and `network()` now accept `curveTolerance` (world units, default `0.25`).
Set it to `0.25 / maxZoom` for sub-pixel curves at your deepest zoom:

```ts
const chart = plot(host, { width, height, curveTolerance: 0.25 / 40 });
chart.enableZoom([0.5, 40]);
```

Opt-in and default-preserving: omitting it bakes exactly the same geometry as before. It costs
nothing per frame — the refinement is paid entirely in the one-time bake — but an arc's segment
count grows as `1/sqrt(tolerance)`, so `0.25 / 40` records ~6.3× the vertices **of the curved
drawables only** (straight paths, `rect`s and `points()` circles are untouched).
