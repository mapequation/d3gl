---
"@mapequation/d3gl": patch
---

The GPU force layout's (`layout({ backend: "gpu" })`) Barnes-Hut repulsion no longer counts a node's own
mass in the grid cells it sits in, as the CPU quadtree already does at its leaves (#403). On the multilevel
seed's coarse levels a heavy supernode of mass m_i that shared its finest cell with a light one of mass m_j
was repelled about m_i / 2m_j times too strongly, and one alone in its cell pushed itself by a rounding
error, so the seed threw heavy supernodes out of place. The first frame then showed stragglers: on
web-NotreDame it spanned 1.27 × 1.41 times the settled layout (M1 Max), and a fit view zoomed in over the
next frames. It now spans 1.00 × 1.06 times, as the CPU seed does (1.01 × 1.04), and the seed's Barnes-Hut
levels match the CPU's solve of the same levels.

The seeded layout also converges sooner and ends where the CPU layout does. On web-NotreDame it meets the
CPU layouts' convergence rule at tick 118 instead of 149 (the worker backend stops at 116), about 1 s
sooner in the Network Navigator, and its mean edge length at tick 150 is 459 instead of 495, against the
CPU layout's 461. The seed frame's mean edge length is 528 instead of 679, already below the 586 a disc
start ends at after 300 ticks. These figures replace the tick-149, 495 and 679 figures of the GPU
multilevel seed entry (#353).

On a graph that takes the Barnes-Hut path (above 4,096 nodes by default; smaller graphs use the exact
loop and are unchanged), a node that shares its finest cell with one other node now gets that node's exact
push, where it got 4/3 of it. A Barnes-Hut tick costs the same or slightly less. Timed from web-NotreDame's
settled layout in batches of 20 ticks on an M1 Max, it went from 10.2 to 10.0 ms at 325k nodes, and stayed
at about 36.5 ms on a 1M-node disc without edges. That setup differs from the one behind the tile pyramid
entry's 10.8 and 35.6 ms (#354), so compare each pair of figures only with itself.
