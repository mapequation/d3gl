---
"@mapequation/d3gl": patch
---

WebGL draws the edges of discs, node rings, module-boundary rings, pie wedges and points antialiased, as
Canvas does, at any devicePixelRatio: each edge is a one-device-pixel coverage ramp where it used to keep or
drop whole pixels (#570). `toPNG()` on WebGL exports the canvas as drawn (#569): at the screen's device
pixels (CSS size × devicePixelRatio, as Canvas exports already were), with its antialiasing, and with
translucent colours no longer darkened. Pass-through points no longer darken where they are translucent.
