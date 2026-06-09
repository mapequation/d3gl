import { defineConfig } from "tsup";
// Imported for its `version`, inlined into the bundle (see `define` below) so
// `import { version } from "@mapequation/d3gl"` stays in sync with package.json
// without shipping the JSON file at runtime. A JSON import (rather than node:fs)
// keeps this config type-checkable without @types/node.
import pkg from "./package.json";

// Single published package built from the internal modules under src/. Each
// entry becomes a subpath export (the `index` entry is the root, = core).
// luma.gl / d3 / react stay external (declared as dependencies / peer
// dependencies in package.json); dts emits per-entry declarations.
export default defineConfig({
  // Replace the `__D3GL_VERSION__` placeholder (src/core/version.ts) at build time.
  define: { __D3GL_VERSION__: JSON.stringify(pkg.version) },
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
  splitting: true,
  treeshake: true,
  sourcemap: true,
  target: "es2020",
});
