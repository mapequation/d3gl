---
"@mapequation/d3gl": patch
---

Building the half-arrow link style is much faster on large directed networks: each link's reciprocal (the `oppositeWidth` a pair nests with) is found with two counting sorts instead of a `Map` keyed by node pair, and its width is read back instead of computed again. On a road network of 2M nodes and 5.5M directed links this drops from about 4 s to about 0.2 s, on every style change with LOD off and on the first frame with LOD on (whose leaf links draw from the same per-link style). The result is unchanged, including which of several parallel links is taken (the last one).
