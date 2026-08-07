---
"@mapequation/d3gl": patch
---

Test-infrastructure only, no library change: the at-scale legs of the CI perf tier now assert
instead of only printing numbers. Six benches (`BENCH_FRONTIER`, `BENCH_SUPER_EDGES`,
`BENCH_LABEL_CANDIDATES`, `BENCH_POINTS`, `BENCH_HIT`, `BENCH_DRAG`) ran at `PERF_N=500000` in a
blocking CI job and gated on nothing but the per-file timeout, so an at-scale regression in any of
them would have gone unnoticed. Each now asserts its deterministic signature plus a calibrated
wall-clock ceiling, `super-edges` gained the all-leaves frontier case it documented but never
measured at scale, and two benches that hard-coded 1M now honour the tier's `PERF_N`.
