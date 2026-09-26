---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu" })` no longer freezes the page while it runs (#352). Each streamed frame used
to queue a batch of ticks and then read every position back synchronously, which blocked the main
thread until the GPU had finished. On web-NotreDame (325,729 nodes, 1.5M edges, M1 Max) animation-frame
tasks took 45 ms on average and up to 366 ms, the main thread spent 97% of the run in long tasks, and the
page drew about 11 frames per second. Now a frame reads positions back from a copy the GPU finished
earlier (a fenced `STREAM_READ` pixel buffer). It then encodes only as much layout work as fits a GPU
budget of `min(10 ms, 0.6 × the frame interval)`. A tick larger than the budget is split across frames
in row bands, and the result is bitwise equal to an unsplit tick. Layout repaints happen in the same
frame as the readback, at most 20 per second, and take at most about half of the main thread and the
GPU. A tab that was hidden never delays them.

On web-NotreDame the transport's own main-thread work is 0.3 ms per frame on average (p95 0.8 ms), and
the page renders at 120 fps while the layout streams (measured in Chromium at 120 Hz). The layout now
gets at most about 60% of the GPU, so 300 ticks take 10.9 s instead of 5.7 s of frozen page. A node drag
reheats through the same budget. The page keeps 75-110 fps while a node is held, where the old path
spent 97% of the drag in long tasks at about 17 fps. `settled` resolves only after the final positions
have been read back. If the WebGL context is lost, or the layout turns non-finite, the run stops with one
warning and keeps the last finite positions. Before, it polled forever or streamed NaN.
