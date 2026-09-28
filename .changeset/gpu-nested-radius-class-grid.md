---
"@mapequation/d3gl": patch
---

The GPU nested layout (`layout({ backend: "gpu", nested })`) no longer stalls frames on a module whose
children's sizes are very uneven (#380). Its disc collision used one grid per module, with cells as wide
as the module's largest discs, so a module of many small children next to a few large ones tested nearly
every pair: time quadratic in the module, one 55 ms step at 60,000 children and frames stalling for over
100 ms while it packed. Each disc is now binned at the scale of its own size (cells per radius class, with
the densest cells refined further), the heaviest searches are spread over many GPU threads, and the frame
budget costs each step by the module's contacts instead of its leaf count.

Measured on an Apple M1 Max in Chromium: one module of 60,000 children with power-law flows lays out in
1.4 s (was 5.6 s) and one of 20,000 in 1.0 s (was 2.1 s), without a blocked frame; Infomap's trees of
web-NotreDame (325,729 leaves) in 1.9 s (was 2.1 s), and a 1,000,000-leaf Infomap-like map in 4.5 s (was
5.6 s). The layouts themselves are unchanged: every touching pair of siblings is still found, and the
result is deterministic.
