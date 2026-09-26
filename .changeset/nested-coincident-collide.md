---
"@mapequation/d3gl": patch
---

Nested layout (`layout({ nested: true })`): two sibling discs that land on exactly the same point now separate by their collision distance, along a fixed direction derived from their indices. Before, they were flung about 10⁹ collision distances apart, and scaling the module's children into its disc then shrank every other sibling to a point (#357). Layouts without coincident siblings are unchanged bit for bit.
