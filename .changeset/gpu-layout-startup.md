---
"@mapequation/d3gl": patch
---

Every GPU network layout (`layout({ backend: "gpu" | "auto" })`, flat or `nested`) now compiles its WebGL
programs in parallel and off the main thread (`KHR_parallel_shader_compile`), before it builds its solver. With a
cold shader cache (a first visit, or a new d3gl version), the click that starts a layout no longer freezes the page.
On an M1 Max (Chromium, ANGLE Metal, `network().layout()` from a click, medians of 3 runs), the click's longest
main-thread task went from 1.4-2.1 s to 0.07-0.37 s, and the first frame came 0.7-1.2 s sooner:

| cold shader cache | before | after |
|---|---|---|
| 552 nodes, flat | 1.94 s | 1.23 s |
| 552 nodes, nested | 2.02 s | 1.19 s |
| web-NotreDame (325k nodes), flat | 3.86 s | 2.68 s |
| web-NotreDame, nested | 2.85 s | 1.83 s |

With a warm cache the first frame came 9-29 ms later at 552 nodes and for web-NotreDame's nested layout (the
solver is built one animation frame later, after the compile). For web-NotreDame's flat layout the runs spread
too widely to tell (1.40-1.89 s before, 1.42-1.86 s after). A later layout on the same engine compiles nothing. A device whose float-blend
probe failed before falls back to the worker at once. `layoutTransport` now reads `"gpu"` while the programs
compile. If a link, the probe or the WebGL context then fails, it moves to the worker's transport; read it after
`whenSettled()` for the value the run ended on. A node dragged during the compile is held once the layout starts,
and a render-backend swap during the compile starts the layout on the new device.
