---
"@mapequation/d3gl": patch
---

The GPU force layout's (`layout({ backend: "gpu" })`) Barnes-Hut repulsion no longer counts a node's own
mass in the grid cells it sits in, as the CPU quadtree already did not (#403). On the multilevel seed's
coarse levels a heavy supernode sharing its finest cell with a light one was repelled up to half its own
mass too strongly, and one alone in its cell pushed itself by a rounding error, so the seed threw heavy
supernodes out of place. The first frame then showed stragglers: on web-NotreDame it spanned 1.27 × 1.41
times the settled layout (M1 Max), and a fit view zoomed in over the next frames. It now spans 1.00 × 1.06
times, as the CPU seed does (1.01 × 1.04), and the seed's Barnes-Hut levels match the CPU's solve of the same
levels. On plain graphs a node that shares its finest cell with one other node now gets that node's exact
push, where it got 4/3 of it. The tick costs the same: 10.0 ms instead of 10.2 ms at 325k nodes and 36.4 ms
at 1M on an M1 Max.
