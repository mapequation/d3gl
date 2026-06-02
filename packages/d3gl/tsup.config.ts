import { defineConfig } from "tsup";

// Single published package built from the internal modules under src/. Each
// entry becomes a subpath export (the `index` entry is the root, = core).
// luma.gl / d3 / react stay external (declared as dependencies / peer
// dependencies in package.json); dts emits per-entry declarations.
export default defineConfig({
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
