import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { geoMap, type HoverHit } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { ImperativeSetup } from "../types.js";
import { makeCells, cellsToFeatureCollection, loadWorld } from "../shared/geo-data.js";

const heat = scaleSequential(interpolateViridis).domain([0, 1]);

/**
 * A synthetic value field on a lat/lon grid, colored with `interpolateViridis`
 * and clipped to the land outline, with a hover read-out. The `cells` option is
 * a grid-size exponent (0→1°, 1→2°, 2→4°, 3→8°); changing it re-runs setup and
 * rebuilds the grid. Pure d3gl; the harness owns the slider, backend, and zoom.
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const exp = (options.cells as number) ?? 2; // grid-size exponent from the slider
  const step = 2 ** exp; // degrees: 0→1°, 1→2°, 2→4°, 3→8°
  const cells = makeCells(step);
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const world = loadWorld();
  const projection = fitProjection(geoNaturalEarth1(), cellsToFeatureCollection(cells), width, height);

  // Hover tooltip over the canvas (host is positioned `relative` by the harness).
  const tip = document.createElement("div");
  tip.className =
    "absolute hidden pointer-events-none z-[5] rounded border border-border " +
    "bg-card/95 px-1.5 py-0.5 text-xs text-foreground";
  host.appendChild(tip);

  const map = geoMap(host, { width, height, projection, backend });
  map.layer("ocean", [world.sphere], { fill: "#d4e6f5" });
  map.layer("land", [world.land], { fill: "#e7e7e0" });
  map.layer("cells", cells.map((c) => c.geometry), {
    id: (_g, i) => cells[i]!.id,
    fill: (_g, i) => heat(cells[i]!.value),
    clipTo: "land", // clip the heatmap to the land outline
  });
  map.on("hover", (hit: HoverHit | null, ev: PointerEvent) => {
    const c = hit?.layer === "cells" ? cellById.get(hit.id as string) : undefined;
    if (!c) {
      tip.classList.add("hidden");
      return;
    }
    const r = host.getBoundingClientRect();
    tip.classList.remove("hidden");
    tip.style.left = `${ev.clientX - r.left + 12}px`;
    tip.style.top = `${ev.clientY - r.top + 12}px`;
    tip.textContent = `value ${c.value.toFixed(3)}`;
  });
  map.enableZoom([1, 50]); // scroll to zoom, drag to pan
  map.render();

  return { engine: map, dispose: () => tip.remove() };
};
