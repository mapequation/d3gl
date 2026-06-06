---
"@mapequation/d3gl": minor
---

GPU-accelerate orthographic-globe rotation on the WebGL backend: the map is baked
into an equirectangular texture and drawn on a spinning 3D sphere, so rotation and
zoom are uniform updates instead of per-frame re-projection. Activation is
automatic (WebGL + orthographic); canvas/SVG and other projections are unchanged.
`GeoMap.enableZoom(extent)` now auto-dispatches: versor rotation for spherical
projections (azimuthal, `clipAngle > 0`), affine pan/zoom for flat ones.
