---
"@mapequation/d3gl": minor
---

Add a `passThrough: true` layer mode for huge / streaming datasets. A pass-through
layer retains **no** per-feature geometry in d3gl (no Scene entry, no hit index):
you own the data and d3gl projects, draws, and discards it on each repaint. This
lifts the retained ceiling (~4–7M features, where Canvas runs out of memory and
WebGL silently stops drawing) up to whatever your own array costs — 250M+ for a
packed `Float32Array`.

- Opt in via `geoMap.layer(name, features, { passThrough: true })` or
  `plot.points(name, data, { passThrough: true })`. The data argument may be a
  **callback** (`() => features`) that d3gl re-invokes on each full repaint, so it
  always reflects your current array; `handle.append(batch)` draws new arrivals
  immediately (O(new)).
- Works for **all GeoJSON geometry** — points/multipoints (analytic circles) and
  polygons/lines (projected paths) — on **both Canvas and WebGL**. WebGL accumulates
  into an offscreen FBO with per-vertex color (no per-drawable color texture) and
  re-tessellates path geometry per repaint.
- Pan/zoom uses snapshot-pan (a slightly stale raster during the gesture, re-crisp
  on settle); full repaints are time-sliced so a multi-million-feature redraw never
  freezes the main thread. `auto` mode upgrades Canvas→WebGL with pass-through
  layers intact.
- Limitations: pass-through layers are not pickable, `clipTo` is not applied to
  them yet, path geometry is world-mode only, and the `svg` backend rejects
  `passThrough`. Retained rendering is unchanged for all existing layers.
