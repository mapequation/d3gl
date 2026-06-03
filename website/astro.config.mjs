import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { fileURLToPath } from "node:url";

// Alias each @mapequation/d3gl subpath to its TypeScript source so the docs run
// against the live library with no build step. Subpath aliases precede the root.
const mod = (name) =>
  fileURLToPath(new URL(`../packages/d3gl/src/${name}/index.ts`, import.meta.url));

export default defineConfig({
  site: "https://mapequation.github.io",
  base: "/d3gl/",
  integrations: [
    starlight({
      title: "d3gl",
      customCss: ["./src/styles/example.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/mapequation/d3gl" }],
      sidebar: [
        { label: "Start Here", items: [{ label: "Getting started", slug: "start-here/getting-started" }] },
        {
          label: "Examples",
          items: [
            { label: "Phylogenetic tree", slug: "examples/tree/phylogenetic-tree" },
            { label: "Ancestral ranges", slug: "examples/tree/ancestral-ranges" },
            { label: "World map", slug: "examples/map/world-map" },
            { label: "GeoJSON features", slug: "examples/map/geojson-features" },
            { label: "Heatmap", slug: "examples/map/heatmap" },
          ],
        },
        // Reference group is appended in a later task via typeDocSidebarGroup.
        { label: "Contributing", items: [{ label: "Contributing", slug: "contributing" }] },
      ],
    }),
  ],
  vite: {
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
  },
});
