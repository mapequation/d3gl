---
"@mapequation/d3gl": patch
---

Every GPU network layout (`layout({ backend: "gpu" | "auto" })`, flat or `nested`) now compiles its WebGL
programs in parallel and off the main thread (`KHR_parallel_shader_compile`), before it builds its solver. With a
cold shader cache (a first visit, or a new d3gl version), the click that starts a layout no longer freezes the page.
On an M1 Max (Chromium, ANGLE Metal, `network().layout()` from a click, medians of 7-11 runs):

| cold shader cache: click → first frame | before | after |
|---|---|---|
| 552 nodes, flat | 1.69 s | 1.12 s |
| 552 nodes, nested | 1.85 s | 1.10 s |
| web-NotreDame (325k nodes), flat | 3.31 s | 2.20 s |
| web-NotreDame, nested | 2.56 s | 1.72 s |
| 1M nodes, flat (LOD on / off) | 4.78 / 3.93 s | 3.25 / 2.40 s |
| 1M nodes, nested (LOD on / off) | 2.65 / 3.18 s | 1.86 / 2.22 s |

The click's longest main-thread task went from 1.3-1.9 s to 0.07-0.7 s.

With a warm cache a flat layout starts as before, within the runs' spread. A nested layout's first frame comes
21-22 ms later at 552 nodes and on web-NotreDame: its compile can only start once its prep is back. At 1M nodes the
nested layout is within noise with LOD on and 0.2 s sooner with LOD off. A later layout on the same engine compiles
nothing. A device whose float-blend probe failed before falls back to the worker at once.

`layoutTransport` now reads `"gpu"` while the programs compile. If a link, the probe or the WebGL context then
fails, it moves to the worker's transport; read it after `whenSettled()` for the value the run ended on. A node
dragged during the compile is held once the layout starts, and a render-backend swap during the compile starts
the layout on the new device.
