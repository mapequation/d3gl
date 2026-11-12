---
"@mapequation/d3gl": minor
---
The GPU network layout starts again on luma.gl 9.4. Before this fix, it always fell back to the CPU worker with "shadertools: assertion failed".

d3gl now declares luma.gl `~9.4.2`, which takes patch releases only. A new luma.gl minor reaches apps only through a d3gl release that has been tested on it.

**Breaking:** an app that also uses luma.gl 9.3 itself, for example through deck.gl 9.3, must move to luma.gl 9.4. Otherwise it loads two copies of luma.gl, and luma.gl throws "multiple versions detected".
