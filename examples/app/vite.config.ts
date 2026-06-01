import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The @d3gl/* workspace packages ship raw TypeScript ("main": "src/index.ts"),
// so alias each to its source entry and let Vite/esbuild transpile them.
const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@d3gl/core": pkg("core"),
      "@d3gl/canvas": pkg("canvas"),
      "@d3gl/webgl": pkg("webgl"),
      "@d3gl/geo": pkg("geo"),
      "@d3gl/labels": pkg("labels"),
      "@d3gl/map": pkg("map"),
      "@d3gl/react": pkg("react"),
      "@d3gl/svg": pkg("svg"),
    },
  },
  server: { fs: { allow: [".."] } },
});
