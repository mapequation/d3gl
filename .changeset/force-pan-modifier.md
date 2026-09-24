---
"@mapequation/d3gl": patch
---
Hold ⌘ (Ctrl on Windows/Linux) while dragging to always pan, even when the drag starts on a draggable node, so a dense `network()` stays navigable with `interactive({ draggable: true })` on. Before, a ⌘-drag that started on a node did nothing at all. The key is built into `enableZoom()`, so on Windows/Linux a Ctrl-drag now pans `plot()` and a flat-projection `geoMap()` too (it used to be ignored). A ⌘/Ctrl-click still toggles multi-selection, shift+drag still draws the marquee and option/alt still subtracts from it.
