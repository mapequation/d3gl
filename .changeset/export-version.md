---
"@mapequation/d3gl": patch
---

Export `version` from the package root, inlined from `package.json` at build time.
Downstream apps can surface the d3gl version (e.g. a "Powered by d3gl v0.4.0" badge)
without importing `@mapequation/d3gl/package.json`:

```ts
import { version } from "@mapequation/d3gl";
console.log(`Powered by d3gl v${version}`);
```
