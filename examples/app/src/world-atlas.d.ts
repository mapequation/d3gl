// The world-atlas package ships TopoJSON data files without type declarations.
// Type the import as `unknown`; bioregions-data.ts narrows it via topojson-client's feature().
declare module "world-atlas/land-110m.json" {
  const topology: unknown;
  export default topology;
}
