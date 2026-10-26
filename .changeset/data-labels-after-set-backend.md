---
"@mapequation/d3gl": patch
---

Plot/geoMap data labels (`labels()`) now show on the new backend straight after `setBackend()` (#581). Before, they stayed on the old backend's path until the next pan or zoom: switching Canvas → WebGL showed no labels, and WebGL → Canvas left the overlay's stale labels on screen.
