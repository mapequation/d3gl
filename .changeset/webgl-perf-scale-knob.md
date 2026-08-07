---
"@mapequation/d3gl": patch
---

Test-infrastructure only, no library change: the browser perf guards can now be driven at a real
fixture size by the CI tier (`PERF_BROWSER_N`, via a `__PERF_N__` define and a `perfN()` helper),
and the `perf-browser` job is no longer advisory. WebGL is the default backend but had the weakest
gate — its guards ran at hardcoded sizes as small as 2000 drawables and their tier could not fail
the build. The engine-level WebGL zoom sweep now runs at 100k in CI instead of 2k.
