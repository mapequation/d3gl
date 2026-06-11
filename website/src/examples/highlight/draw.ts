import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { ImperativeSetup } from "../types.js";
import { makeCells, loadWorld, type Cell } from "../shared/geo-data.js";

const heat = scaleSequential(interpolateViridis).domain([0, 1]);

/**
 * Hover + click interaction on a land-clipped value grid, all through core d3gl:
 * the `hover` option outlines the hovered cell in a tiny overlay layer (the grid's
 * buffers are untouched), `tooltip` reads out its value, and a click selects the
 * cell plus every cell within ±0.1 of its value — `select()` dims the rest to 30%
 * via the `selection` option (one style-table write, no re-tessellation). Clicking
 * open ocean clears the selection (picking is clip-aware, so a cell only counts
 * where it is visibly painted on land). The `cells` slider rebuilds only the grid
 * layer, preserving zoom/pan; a rebuilt grid starts unselected (its ids change).
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const world = loadWorld();
  const projection = fitProjection(geoNaturalEarth1(), { type: "Sphere" }, width, height);

  // The cells the click handler resolves against, kept current as render rebuilds them.
  let cells: Cell[] = [];
  let cellById = new Map<string, Cell>();

  const map = geoMap(host, {
    width, height, projection, backend,
    tooltipClass:
      "rounded border border-border bg-card/95 px-1.5 py-0.5 text-xs text-foreground",
  });
  map.layer("ocean", [world.sphere], { fill: "#d4e6f5" });
  map.layer("land", [world.land], { fill: "#e7e7e0" });
  map.on("click", (hit) => {
    if (hit?.layer !== "cells") {
      map.select("cells", null); // clicked outside the grid: clear
      return;
    }
    const v = cellById.get(hit.id as string)?.value;
    if (v === undefined) return;
    map.select("cells", (_g, i) => Math.abs(cells[i]!.value - v) <= 0.1);
  });
  map.enableZoom([1, 50]); // scroll to zoom, drag to pan (clicks still fire — drags don't)

  return {
    engine: map,
    // Rebuild only the "cells" layer at the chosen grid size; re-pushed at the
    // map's CURRENT transform, so zoom/pan survives a slider change.
    render: (options) => {
      const exp = (options.cells as number) ?? 2; // grid-size exponent from the slider
      const step = 2 ** exp; // degrees: 0→1°, 1→2°, 2→4°, 3→8°
      cells = makeCells(step);
      cellById = new Map(cells.map((c) => [c.id, c]));
      map.layer("cells", cells.map((c) => c.geometry), {
        id: (_g, i) => cells[i]!.id,
        fill: (_g, i) => heat(cells[i]!.value),
        clipTo: "land", // clip the grid to the land outline
        hover: { stroke: "#fff", lineWidth: 1 },
        tooltip: (_g, id) => {
          const c = cellById.get(id as string);
          return c ? `value ${c.value.toFixed(3)}` : null;
        },
        selection: { others: { opacity: 0.3 } },
      });
      map.render();
    },
  };
};
