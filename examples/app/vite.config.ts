import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The single @mapequation/d3gl package ships raw TypeScript modules under
// packages/d3gl/src/<module>; alias each subpath to its source entry and let
// Vite/esbuild transpile. Subpath aliases must precede the root alias so
// "@mapequation/d3gl/map" isn't swallowed by "@mapequation/d3gl".
const mod = (name: string) =>
  fileURLToPath(new URL(`../../packages/d3gl/src/${name}/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@mapequation/d3gl/canvas", replacement: mod("canvas") },
      { find: "@mapequation/d3gl/webgl", replacement: mod("webgl") },
      { find: "@mapequation/d3gl/svg", replacement: mod("svg") },
      { find: "@mapequation/d3gl/geo", replacement: mod("geo") },
      { find: "@mapequation/d3gl/labels", replacement: mod("labels") },
      { find: "@mapequation/d3gl/map", replacement: mod("map") },
      { find: "@mapequation/d3gl/react", replacement: mod("react") },
      { find: /^@mapequation\/d3gl$/, replacement: mod("core") },
    ],
  },
  server: { fs: { allow: [".."] } },
});
