---
"@mapequation/d3gl": minor
---

Add multi-select gestures (#79): `on("select", (selected, ev) => …)` fires whenever the selection set changes, and `selection()` returns the current set as `HoverHit[]`. Plain click selects one (replace); shift/cmd/ctrl-click toggles add/remove; clicking empty space clears. Selected features are styled via the layer's existing `selection: { selected, others }` option (others dimmed by default). It's **opt-in** — the gesture only runs once `on("select")` is registered, so existing single-click/hover behaviour is unchanged — and it's a `BaseEngine` capability, so geoMap and plot get it together. (Selected glyphs on the WebGL *instanced* lane — large decluttered scatters, network frontier — are tracked in the set now; their visual selection highlight follows in the instanced-highlight work.)
