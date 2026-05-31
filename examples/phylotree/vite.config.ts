import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@d3gl/core": pkg("core"),
      "@d3gl/webgl": pkg("webgl"),
      "@d3gl/canvas": pkg("canvas"),
      "@d3gl/svg": pkg("svg"),
      "@d3gl/map": pkg("map"),
      "@d3gl/labels": pkg("labels"),
    },
  },
  server: { fs: { allow: [".."] } },
});
