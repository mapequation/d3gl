---
"@mapequation/d3gl": patch
---

Faster module-map ingestion: `buildModuleLODTree` now registers the module hierarchy with an integer-keyed prefix tree instead of interning ":"-joined path strings — at 1M nodes the build is ~2.4× faster with ~19× less transient allocation, producing identical trees.
