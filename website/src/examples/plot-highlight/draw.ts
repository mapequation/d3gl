import { schemeCategory10 } from "d3-scale-chromatic";
import { plot } from "@mapequation/d3gl/map";
import type { HoverHit } from "@mapequation/d3gl/map";
import type { ImperativeSetup } from "../types.js";
import { makeData } from "./data.js";

const color = (group: number): string => schemeCategory10[group % 10] ?? "#888";
/** A translucent tint of a #rrggbb hex, for the region fills. */
const tint = (hex: string, alpha: number): string =>
  `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;

/**
 * Hover-highlight + multi-select on a `plot` engine — proof that these interactions are
 * universal (they live on the shared base, not on `geoMap`). Two layer kinds drive it:
 * drawn rectangles (`layer` with a `draw` callback) outline each cluster, and `points`
 * are the scatter on top. Both carry the same declarative options: **hover** a point or
 * a region to outline it and read a tooltip; **click** to select individual items — every
 * other point and region dims via the `selection` option. **Shift / Cmd-click** adds or
 * removes items from the selection; click empty space to clear. A small overlay shows the
 * running count. Scroll to zoom, drag to pan.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const { dots, regions } = makeData(width, height);

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

  // Selection count readout — absolutely-positioned overlay, pointer-events-none so it
  // doesn't interfere with mouse interaction on the canvas below.
  const readout = document.createElement("div");
  readout.className =
    "absolute bottom-2 left-2 pointer-events-none text-xs text-foreground/70 select-none";
  host.appendChild(readout);

  const updateReadout = (sel: HoverHit[]): void => {
    const n = sel.length;
    readout.textContent =
      n === 0 ? "Click to select · shift/cmd-click to add" : `${n} selected · shift/cmd-click to add`;
  };
  updateReadout([]);

  // on("select") is the multi-select gesture: plain click = replace, shift/cmd/ctrl-click = toggle,
  // click empty = clear. Styling is applied automatically via the `selection` layer option.
  chart.on("select", updateReadout);

  chart.enableZoom([0.5, 20]); // scroll to zoom, drag to pan (clicks still fire — drags don't)
  chart.render();

  return chart;
};
