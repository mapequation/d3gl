import { defineConfig } from "tsdown";
// Imported for its `version`, inlined into the bundle (see `define` below) so
// `import { version } from "@mapequation/d3gl"` stays in sync with package.json
// without shipping the JSON file at runtime. A JSON import (rather than node:fs)
// keeps this config type-checkable without @types/node. tsdown loads this config
// via native ESM, so the `with { type: "json" }` import attribute is required.
import pkg from "./package.json" with { type: "json" };

// Single published package built from the internal modules under src/. Each
// entry becomes a subpath export (the `index` entry is the root, = core).
// luma.gl / d3 / react stay external (declared as dependencies / peer
// dependencies in package.json); dts emits per-entry declarations.
export default defineConfig({
  // Replace the `__D3GL_VERSION__` placeholder (src/core/version.ts) at build time.
  define: { __D3GL_VERSION__: JSON.stringify(pkg.version) },
  // tsdown defaults to `.mjs`/`.d.mts` (fixedExtension, since platform is "node").
  // The package is `"type": "module"`, so plain `.js`/`.d.ts` is already ESM —
  // keep them to match the `exports` map and the published file layout.
  fixedExtension: false,
  entry: {
    index: "src/core/index.ts",
    canvas: "src/canvas/index.ts",
    webgl: "src/webgl/index.ts",
    svg: "src/svg/index.ts",
    geo: "src/geo/index.ts",
    labels: "src/labels/index.ts",
    map: "src/map/index.ts",
    react: "src/react/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  // tsdown (rolldown) splits shared chunks automatically; tsup's `splitting`
  // option has no tsdown equivalent and was dropped in the migration.
  treeshake: true,
  sourcemap: true,
  target: "es2020",
});
