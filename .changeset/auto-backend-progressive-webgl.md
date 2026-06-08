---
"@mapequation/d3gl": minor
---

Add an opt-in `backend: "auto"` mode that paints with the Canvas backend
synchronously for an instant first paint, then creates the WebGL device in the
background and swaps to it transparently when ready. `whenReady()` (and the React
`onReady`) resolve at the canvas first paint, so consumers see a working map
immediately without paying the WebGL device-creation startup cost up front. If
WebGL is unavailable the map stays on Canvas (with a `console.warn`). Existing
`"webgl"` / `"canvas"` / `"svg"` behavior is unchanged.
