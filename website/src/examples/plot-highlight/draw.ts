import { schemeCategory10 } from "d3-scale-chromatic";
import { plot } from "@mapequation/d3gl/map";
import type { ImperativeSetup } from "../types.js";
import { makeData, type Dot, type Region } from "./data.js";

const color = (group: number): string => schemeCategory10[group % 10] ?? "#888";
/** A translucent tint of a #rrggbb hex, for the region fills. */
const tint = (hex: string, alpha: number): string =>
  `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;

/**
 * The same interaction as the geographic Highlight example, but on a `plot` engine —
 * proof that `hover` / `tooltip` / `selection` are universal (they live on the shared
 * base, not on `geoMap`). Two layer kinds drive it: drawn rectangles (`layer` with a
 * `draw` callback) outline each cluster, and `points` are the scatter on top. Both carry
 * the same declarative options: **hover** a point or a region to outline it in a tiny
 * overlay and read a tooltip; **click** either to select the whole cluster — every other
 * point and region dims via `select()` + the `selection` option. Click empty space to
 * clear. Scroll to zoom, drag to pan.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const { dots, regions } = makeData(width, height);
  const groupOf = new Map(dots.map((d) => [d.id, d.group]));

  const chart = plot(host, {
    width, height, backend,
    tooltipClass:
      "rounded border border-border bg-card/95 px-1.5 py-0.5 text-xs text-foreground",
  });

  // Drawn rectangles (the `draw` callback) — behind the points, so points win the pick
  // where they overlap and a region is hit only in the gaps between its dots.
  chart.layer("regions", regions, {
    draw: (ctx, r) => ctx.rect(r.x, r.y, r.w, r.h),
    fill: (r) => tint(color(r.group), 0.1),
    stroke: (r) => tint(color(r.group), 0.6),
    lineWidth: 1,
    id: (r) => `r${r.group}`,
    hover: { stroke: "#fff", lineWidth: 2 },
    tooltip: (r) => `cluster ${r.group}`,
    selection: { others: { opacity: 0.15 } },
  });

  chart.points("dots", dots, {
    x: (d) => d.x,
    y: (d) => d.y,
    radius: 5,
    fill: (d) => color(d.group),
    id: (d) => d.id,
    hover: { stroke: "#fff", lineWidth: 2, radiusScale: 1.4 },
    tooltip: (d) => `cluster ${d.group} · ${d.value.toFixed(2)}`,
    selection: { others: { opacity: 0.25 } },
  });

  chart.on("click", (hit) => {
    if (hit?.layer !== "dots" && hit?.layer !== "regions") {
      chart.select("dots", null); // clicked empty space: clear both layers
      chart.select("regions", null);
      return;
    }
    const g = hit.layer === "dots" ? groupOf.get(hit.id as string) : Number((hit.id as string).slice(1));
    chart.select("dots", (d: Dot) => d.group === g);
    chart.select("regions", (r: Region) => r.group === g);
  });
  chart.enableZoom([0.5, 20]); // scroll to zoom, drag to pan (clicks still fire — drags don't)
  chart.render();

  return chart;
};
