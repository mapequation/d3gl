---
"@mapequation/d3gl": patch
---

`backend: "auto"` no longer blocks the main thread on large inputs. The Canvas2D placeholder
installed while the WebGL device is being created used to tessellate and paint the full scene —
on a 12,957-node / 610,954-edge network that was ~19 s of blocked main thread before the first
WebGL frame. Content that only exists on canvas because a vector backend has no instanced lane
(a `network()` graph, a decluttered `plot.points()` layer) is now withheld from the placeholder
above ~10,000 elements, so the incoming WebGL backend paints the first frame instead: the same
graph now reaches its first frame in ~0.2 s, matching `backend: "webgl"`. Smaller scenes keep the
instant canvas first paint unchanged, and if WebGL turns out to be unavailable the engine falls
back to canvas and draws the full detail there.
