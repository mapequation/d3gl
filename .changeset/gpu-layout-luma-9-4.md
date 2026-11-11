---
"@mapequation/d3gl": patch
---
The GPU network layout starts again on luma.gl 9.4. Before this fix, it always fell back to the CPU worker with "shadertools: assertion failed".

d3gl now declares luma.gl `~9.4.2`, which takes patch releases only. A new luma.gl minor now reaches apps through a d3gl release that has been tested on it.
