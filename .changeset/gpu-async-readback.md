---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu" })` no longer freezes the page while it runs (#352). Each streamed frame used
to queue a batch of ticks and then read every position back synchronously, which blocked the main
thread until the GPU had finished: about 230 ms per frame at 325k nodes, a 4 fps UI. Now the frame
reads the positions back from a copy the GPU finished earlier (a fenced `STREAM_READ` pixel buffer),
then encodes only as much layout work as fits a GPU budget of `min(10 ms, 0.6 × the frame interval)`.
A tick larger than the budget is split across frames in row bands, with results bitwise equal to an
unsplit tick. Layout repaints happen in the same frame as the readback, at most 20 per second and at
most about half of the main thread and GPU time.

On web-NotreDame (325,729 nodes, 1.5M edges, M1 Max, 120 Hz), the transport's own main-thread work is
0.2-0.3 ms per frame (p95 0.8 ms) and the page renders at 120 fps while the layout streams. Before, the
main thread spent 97% of the run in long tasks of up to 366 ms. The layout now gets at most about 60%
of the GPU, so 300 ticks take 10.9 s instead of 5.7 s of frozen page. `settled` resolves only after the
final positions have been read back. A lost WebGL context or a layout that turns non-finite now stops
the run with one warning instead of polling forever or streaming NaN.
