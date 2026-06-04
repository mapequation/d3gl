import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { geoMap, type HoverHit } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { ExampleHandle, ExampleOptions, ExampleSize } from "../types.js";
import { makeCells, cellsToFeatureCollection, loadWorld, type Cell } from "../shared/geo-data.js";

const heat = scaleSequential(interpolateViridis).domain([0, 1]);

export function mount(el: HTMLElement, opts: ExampleOptions, size: ExampleSize): ExampleHandle {
  const { width: W, height: H } = size;
  const exp = (opts.cells as number) ?? 2;    // grid-size exponent from the slider
  const step = 2 ** exp;                       // degrees: exp 0→1°, 1→2°, 2→4°, 3→8°
  const cells = makeCells(step);
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const world = loadWorld();
  const projection = fitProjection(geoNaturalEarth1(), cellsToFeatureCollection(cells), W, H);

  el.style.position = "relative";
  const tip = document.createElement("div");
  tip.style.cssText = "position:absolute;pointer-events:none;background:rgba(255,255,255,.96);" +
    "border:1px solid #ccc;border-radius:4px;padding:3px 7px;font-size:12px;color:#222;display:none;z-index:5;";
  el.appendChild(tip);

  const map = geoMap(el, { width: W, height: H, projection, backend: opts.backend });
  map.layer("ocean", [world.sphere], { fill: "#d4e6f5" });
  map.layer("land", [world.land], { fill: "#e7e7e0" });
  map.layer("cells", cells.map((c) => c.geometry), {
    id: (_g, i) => cells[i]!.id,
    fill: (_g, i) => heat(cells[i]!.value),
    clipTo: "land",                            // clip the heatmap to the land outline
  });
  map.on("hover", (hit: HoverHit | null, ev: PointerEvent) => {
    const c = hit?.layer === "cells" ? cellById.get(hit.id as string) : undefined;
    if (!c) { tip.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    tip.style.display = "block";
    tip.style.left = `${ev.clientX - r.left + 12}px`;
    tip.style.top = `${ev.clientY - r.top + 12}px`;
    tip.textContent = `value ${c.value.toFixed(3)}`;
  });
  map.enableZoom([1, 50]);                      // scroll to zoom, drag to pan
  map.render();

  let currentBackend = opts.backend;
  return {
    dispose: () => { tip.remove(); map.destroy(); },
    setBackend: (b) => { currentBackend = b; map.setBackend(b); },
    exportImage: () =>
      currentBackend === "svg" ? { format: "svg", data: map.toSVG() } : { format: "png", data: map.toPNG() },
  };
}
