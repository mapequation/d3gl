---
"@mapequation/d3gl": patch
---

Pass-through layers now follow a host resize on the WebGL backend. `setSize()` (or a responsive
container resize) used to leave the pass-through accumulation surface at its original size, so a
pass-through layer was drawn stretched to the new box — a Plot point at (60, 60) landed at
(90, 45) after a 200×200 → 300×150 resize, and screen-sized points turned into ellipses. The
surface is now re-created at the new size and refilled by the repaint `setSize()` already runs.
The Canvas backend already handled a resize at rest and is now covered by the same tests.
