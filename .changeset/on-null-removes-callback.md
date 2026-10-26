---
"@mapequation/d3gl": patch
---

`on("hover" | "click" | "select", null)` removes the callback, as d3's `selection.on(type, null)` does (#558).
