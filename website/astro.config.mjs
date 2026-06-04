import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
// starlight-typedoc exports the plugin as the default export; the named
// `typeDocSidebarGroup` is the sidebar placeholder injected where the generated
// Reference group should appear.
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

import react from "@astrojs/react";

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
  // `readmeLabel` is the visible label of the "Overview" link that
  // starlight-typedoc injects at the top of each module group once the TypeDoc
  // `readme` option (below) is configured — this is what makes each module's
  // overview page reachable from the sidebar.
  sidebar: { label: "Reference", collapsed: true, readmeLabel: "Overview" },
  typeDoc: {
    // Each module's `@packageDocumentation` overview lives on its module index
    // page; `entryFileName: "index"` names those pages `index.md` (instead of
    // the default `README.md`, which starlight-typedoc strips for multi-entry-
    // point setups) so the overview survives and tops each module reference page.
    entryFileName: "index",
    // starlight-typedoc only emits the "Overview" sidebar link inside each
    // module group when the TypeDoc `readme` option is configured (it gates the
    // readmeUrls map on `isReadmeConfigured`, which is false for the default
    // `readme: "none"`). Pointing it at the package README makes each module's
    // generated `index.md` (its `@packageDocumentation` overview page) register
    // as a reachable "Overview" entry under the module's sidebar group.
    readme: fileURLToPath(
      new URL("../packages/d3gl/README.md", import.meta.url),
    ),
    // Without this, configuring `readme` would split the Reference root into a
    // separate README page + a `modules.md` table page. `mergeReadme: true`
    // keeps a single root `index.md` that appends the scannable module table
    // under the README, so the root stays the clickable module table.
    mergeReadme: true,
    // Render index sections (the Reference root's module list, and each module
    // page's Classes/Interfaces/Functions lists) as tables with a Description
    // column. On the root this turns the bare list of 8 modules into a scannable
    // table where each module shows the first line of its `@packageDocumentation`
    // summary, so readers can tell modules apart before clicking in.
    indexFormat: "table",
    // The summary column links to the symbol; an explicit type column would just
    // repeat "Module" for every row, so keep the table to name + description.
    tableColumnSettings: { hideSources: true },
  },
});

export default defineConfig({
  site: "https://mapequation.github.io",
  base: "/d3gl/",
  integrations: [starlight({
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
          { label: "React", slug: "examples/react" },
        ],
      },
      typeDocSidebarGroup,
      { label: "Contributing", items: [{ label: "Contributing", slug: "contributing" }] },
    ],
  }), react()],
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