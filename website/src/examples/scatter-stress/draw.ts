import { schemeCategory10 } from "d3-scale-chromatic";
import { plot, h } from "@mapequation/d3gl/map";
import type { ImperativeSetup } from "../types.js";
import { makePoints, type Point } from "./data.js";

type SizeMode = "world" | "screen";

const color = (category: number): string => schemeCategory10[(category - 1) % 10] ?? "#888";

/** Hover-tooltip body: every property of the point, as a labelled table. The header is a
 *  color swatch + the category; rows show id, x/y, value, and radius. Built with d3gl's `h`
 *  hyperscript so the engine's shared tooltip renders it. */
function pointTooltip(d: Point): HTMLElement {
  const row = (key: string, value: string): HTMLElement =>
    h("tr", null, [
      h("td", { class: "pr-2 opacity-60" }, key),
      h("td", { class: "text-right tabular-nums" }, value),
    ]);
  return h("div", null, [
    h("div", { class: "mb-1 flex items-center gap-1.5 font-semibold" }, [
      h("span", {
        class: "inline-block h-2.5 w-2.5 rounded-sm",
        style: `background:${color(d.category)}`,
      }),
      `category ${d.category}`,
    ]),
    h("table", { class: "border-collapse" }, [
      row("id", d.id),
      row("x", d.x.toFixed(1)),
      row("y", d.y.toFixed(1)),
      row("value", d.value.toFixed(3)),
      row("radius", d.radius.toFixed(2)),
    ]),
  ]);
}

/**
 * A hover/selection stress test on a `plot` scatter: the **points** slider grows the cloud
 * from 32 to ~1M points, each with a random category 1–10 (color) and a random value
 * (radius). **Hover** any point for a tooltip of all its properties; **click** a point to
 * select its whole category — every other point dims.
 * Click empty space to clear. Scroll to zoom, drag to pan. The **coords** toggle picks
 * `world` (radii scale with zoom) vs `screen` (constant-pixel radii). The hit index keeps
 * hover instant even at the top of the range. Pure d3gl; the harness owns the controls.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const W = width, H = height;

  const chart = plot(host, {
    width: W, height: H, backend,
    // Themed (dark-mode aware) tooltip card — now honored on `plot` via BaseEngineOptions.
    tooltipClass:
      "rounded border border-border bg-card/95 px-1.5 py-0.5 text-xs text-foreground",
  });

  // Click selection is wired once: it reads the clicked point's category from a lookup that
  // `render` refreshes whenever the point cloud is rebuilt, then selects the whole category.
  let categoryOf = new Map<string, number>();
  chart.on("click", (hit) => {
    if (hit?.layer !== "dots") {
      chart.select("dots", null); // clicked empty space: clear the selection
      return;
    }
    const cat = categoryOf.get(hit.id as string);
    chart.select("dots", (d: Point) => d.category === cat);
  });
  chart.enableZoom([0.5, 20]); // scroll to zoom, drag to pan (clicks still fire — drags don't)

  return {
    engine: chart,
    // Rebuild the point cloud when `points` or `coords` change; never touches the transform,
    // so the current zoom/pan survives an option change.
    render: (options) => {
      const count = 2 ** ((options.points as number) ?? 10); // 2^exp points (exp 5..16)
      const sizeMode = (options.coords as SizeMode) ?? "world";

      const points = makePoints(count, W, H);
      categoryOf = new Map(points.map((p) => [p.id, p.category]));

      chart.points("dots", points, {
        x: (d) => d.x,
        y: (d) => d.y,
        radius: (d) => d.radius,
        fill: (d) => color(d.category),
        id: (d) => d.id,
        sizeMode,
        hover: { stroke: "#fff", lineWidth: 2, radiusScale: 1.4 },
        tooltip: (d) => pointTooltip(d),
        selection: { others: { opacity: 0.2 } },
      });

      chart.render();
    },
  };
};
