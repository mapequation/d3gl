---
"@mapequation/d3gl": patch
---

Fix the network force layout settling into an axis-aligned square with clusters pressed into the four corners on large dense graphs (#203). Two integrator fixes, applied identically on the CPU worker and GPU backends: a per-node semi-implicit spring stabilizer (`1/(1+K̃)`, `K̃ = damping·α·attraction·degree`) so high-degree hubs can no longer turn the spring integration oscillatory-unstable and eject their clusters ballistically, and an isotropic (vector-magnitude) per-tick step clamp replacing the per-axis clamp that channelled any runaway motion along ±45° into the corners of a square. Equilibrium layouts are unchanged; hub-heavy graphs now settle instead of jittering at the step clamp.
