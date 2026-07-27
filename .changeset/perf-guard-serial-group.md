---
"@mapequation/d3gl": patch
---

Test-infrastructure only, no library change: the node wall-clock perf guards now run in their own
serial vitest group so they measure an uncontended machine. Four sessions had chased intermittent
budget failures that turned out to be parallel-worker contention (the suite's test time inflates
4.2× under parallelism), not regressions.
