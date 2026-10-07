---
"@mapequation/d3gl": patch
---
`network().lod({ declutterSpacing })` now defaults to 2 (was 1): drawn glyphs keep enough room between them for their links to show. Pass `declutterSpacing: 1` for the previous density.
