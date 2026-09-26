---
"@mapequation/d3gl": patch
---

The worker layout starts drawing a large graph while its multilevel seed is still running, so you no longer look at a blank canvas until the seed finishes.

- **Seed progress frames.** While the multilevel seed solves its coarse levels, the worker posts the seed so far: the level being solved, projected down onto every node. It posts only levels with about a thousand nodes or more, whose projection already spans the finished seed (0.86–1.05× on every graph measured). The coarser levels are a few mass-sized discs with gaps between them and would be up to 2.4× too wide, so a fitted view would zoom out on them and then back in. The LOD geometry is sent with each frame, and the main thread draws each frame with one LOD cut, the same way it draws a refinement frame.
- **Paced by time.** Frames are at least 16 ms apart, and at least three times as far apart as a frame takes to build, so posting takes at most a quarter of the seed's time. On web-NotreDame (325k nodes) the first frame arrives 42 ms into the seed instead of after the whole ~1.05 s seed. About 12 frames follow, and the seed takes about 0.27 s longer (roughly 1% of the time to convergence).
- **Pin and stop during the seed.** A node grabbed on a seed frame is held from the first refinement tick. A stop ends the seed without a seed frame or refinement.
- **Same result.** The seed runs the same ticks in the same order. On web-NotreDame the seed and the converged layout are bit-identical to before.
