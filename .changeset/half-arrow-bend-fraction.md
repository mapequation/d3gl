---
"@mapequation/d3gl": minor
---
**Breaking:** `linkBend` for `linkStyle: "half-arrow"` is now a fraction of the link's length (as it already was for `"line"`), not an absolute world/pixel offset. In `sizeMode: "screen"` the bow used to stay a fixed pixel size while the link shrank, so links bulged into near-semicircles as you zoomed out; now each link keeps its shape at every zoom, on WebGL, Canvas, SVG and in `toSVG()` exports. Migrate by dividing the old value by a typical link length (e.g. `linkBend: 30` on a ~215-unit link → `0.14`; `0.15` is a good default).
