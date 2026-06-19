import { interpolateBlues } from "d3-scale-chromatic";
import { plot } from "@mapequation/d3gl/map";
import type { ImperativeSetup } from "../types.js";
import { makePoints, type Point } from "./data.js";

/** Importance → fill (darker = more important), kept off the pale end for contrast on white. */
const color = (importance: number): string => interpolateBlues(0.35 + 0.6 * importance);

/**
 * The declutter example at scale: the same screen-space cull as the labelled scatter, but each
 * node is an **analytic GPU point** (`chart.points`, `sizeMode: "screen"`) instead of a
 * tessellated `ctx.arc` path. A point is ~4 vertices vs. tens for a tessellated circle, so the
 * **Nodes** slider goes to ~1M without the geometry-memory wall of the path version.
 *
 * `declutter` works on points the same way: each point's anchor is its center (no explicit
 * `anchor` needed), and the engine hides points whose projected center lands within `declutter`
 * px of an already-kept one — earlier data wins, so sorting by importance descending keeps the
 * big ones. No labels (the HTML `LabelLayer` reprojects every anchor per zoom and won't follow a
 * million points) and `pickable: false` (a 1M-entry hit index would dwarf the geometry), so this
 * is a pure glyph-declutter stress test. Scroll to zoom (deep range), drag to pan.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const W = width, H = height;

  const chart = plot(host, { width: W, height: H, backend });
  chart.enableZoom([0.3, 40]); // scroll to zoom, drag to pan — deep range to fully resolve crowding

  return {
    engine: chart,
    render: (options) => {
      const count = 2 ** ((options.nodes as number) ?? 14);
      const declutterPx = (options.declutter as number) ?? 30;

      // Sort by importance DESC so the biggest points win declutter ties (priority = input order).
      const points = makePoints(count, W, H).sort((a, b) => b.importance - a.importance);

      chart.points("nodes", points, {
        x: (d: Point) => d.x,
        y: (d: Point) => d.y,
        radius: (d: Point) => d.radius,
        fill: (d: Point) => color(d.importance),
        sizeMode: "screen", // constant pixel size — declutter compares on-screen distances
        declutter: declutterPx > 0 ? declutterPx : undefined,
        id: (d: Point) => d.id,
        pickable: false, // no hover/pick: skip the per-point hit index so ~1M stays lean
      });

      chart.render();
    },
  };
};
