---
"@mapequation/d3gl": patch
---

Fix the GPU grid-pyramid Barnes-Hut near-field overestimate for sub-cell clumps (#251). The finest-level forced accept now softens the lumped cell by its occupants' second central moment (`ε = 2σ²` — the equivalent uniform-disc law at the clump's actual extent), fed by a second-moment channel accumulated in the pyramid scatter's previously unused w component. Single-occupant cells have `σ² = 0` exactly and keep the plain point kernel; the θ-accepted far field is bit-identical to before. One-tick clump probe (100-node radius-2 clump inside one finest cell of a G=32 pyramid): GPU/CPU BH max-force ratio 5.4× → 0.48×; pyramid-vs-all-pairs field parity (2000 nodes, θ=0.5) improves from relL2 0.24 to 0.047.
