import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
// starlight-typedoc exports the plugin as the default export; the named
// `typeDocSidebarGroup` is the sidebar placeholder injected where the generated
// Reference group should appear.
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Alias each @mapequation/d3gl subpath to its TypeScript source so the docs run
// against the live library with no build step. Subpath aliases precede the root.
const mod = (name) =>
  fileURLToPath(new URL(`../packages/d3gl/src/${name}/index.ts`, import.meta.url));

// The 8 library module entry points documented by the API reference.
const referenceEntryPoints = [
  "../packages/d3gl/src/core/index.ts",
  "../packages/d3gl/src/canvas/index.ts",
  "../packages/d3gl/src/webgl/index.ts",
  "../packages/d3gl/src/svg/index.ts",
  "../packages/d3gl/src/geo/index.ts",
  "../packages/d3gl/src/labels/index.ts",
  "../packages/d3gl/src/map/index.ts",
  "../packages/d3gl/src/react/index.ts",
];

const typeDocPlugin = starlightTypeDoc({
  entryPoints: referenceEntryPoints,
  tsconfig: "../packages/d3gl/tsconfig.json",
  output: "reference",
  sidebar: { label: "Reference", collapsed: true },
  // Each module's `@packageDocumentation` overview lives on its module index
  // page; `entryFileName: "index"` names those pages `index.md` (instead of the
  // default `README.md`, which starlight-typedoc strips for multi-entry-point
  // setups) so the overview survives and tops each module reference page.
  typeDoc: { entryFileName: "index" },
});

export default defineConfig({
  site: "https://mapequation.github.io",
  base: "/d3gl/",
  integrations: [
    starlight({
      title: "d3gl",
      customCss: ["./src/styles/global.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/mapequation/d3gl" }],
      plugins: [typeDocPlugin],
      sidebar: [
        { label: "Start Here", items: [{ label: "Getting started", slug: "getting-started" }] },
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
        typeDocSidebarGroup,
        { label: "Contributing", items: [{ label: "Contributing", slug: "contributing" }] },
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
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
