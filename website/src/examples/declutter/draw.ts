import { interpolateBlues } from "d3-scale-chromatic";
import { plot, h } from "@mapequation/d3gl/map";
import type { ImperativeSetup } from "../types.js";
import { makeNodes, type Node } from "./data.js";

const GAP = 4; // px between a node's edge and its label
const LABEL_STYLE = { font: "11px system-ui, sans-serif", color: "#333", textShadow: "none" };

/** Importance → fill (darker = more important), kept off the pale end for contrast on white. */
const color = (importance: number): string => interpolateBlues(0.35 + 0.6 * importance);

/** Hover-tooltip body: the node's name, importance, radius, and priority — so the channel that
 *  drives decluttering (importance/priority) is visible. Built with d3gl's `h` hyperscript. */
function nodeTooltip(d: Node): HTMLElement {
  const row = (key: string, value: string): HTMLElement =>
    h("tr", null, [
      h("td", { class: "pr-2 opacity-60" }, key),
      h("td", { class: "text-right tabular-nums" }, value),
    ]);
  return h("div", null, [
    h("div", { class: "mb-1 font-semibold" }, d.label),
    h("table", { class: "border-collapse" }, [
      row("importance", d.importance.toFixed(3)),
      row("radius", `${d.radius.toFixed(1)} px`),
      row("priority", d.importance.toFixed(3)),
    ]),
  ]);
}

/**
 * A scatter built to showcase d3gl's **declutter** API. Each node is a constant-pixel circle
 * (`sizeMode: "screen"`) pinned to a world `anchor`, with a name label from the engine's
 * `chart.labels(...)`. Two collision systems run on every zoom/pan:
 *
 *   1. Glyph declutter — `layer({ anchor, sizeMode: "screen", declutter: <px> })` hides any
 *      circle whose anchor lands within `<px>` of an already-kept one. Ties break by INPUT
 *      ORDER, so sorting the data by importance descending makes the big nodes win.
 *   2. Label culling — `chart.labels` drops labels whose boxes overlap, highest importance first
 *      (the engine measures each label's text and re-places them as you zoom).
 *
 * Both are screen-space: zoom OUT crowds the anchors → low-priority nodes and overlapping
 * labels drop out; zoom IN spreads them → everything returns. The **Declutter** slider is the
 * literal `declutter` radius in pixels (0 = off); the **Nodes** slider grows the cloud to 262k.
 *
 * Glyph declutter is an O(n) spatial-grid pass that scales well; label placement reprojects
 * every anchor per zoom and does not. The **Labels** toggle drops the labels so the d3gl
 * declutter + GPU path can be stress-tested on its own at high node counts.
 *
 * Pure d3gl; the harness owns the controls, backend, export, and the screen size.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const W = width, H = height;

  const chart = plot(host, {
    width: W, height: H, backend,
    tooltipClass:
      "rounded border border-border bg-card/95 px-1.5 py-0.5 text-xs text-foreground",
  });
  chart.enableZoom([0.3, 40]); // scroll to zoom, drag to pan (deep range); labels track the transform

  return {
    engine: chart,
    // (Re)build the node layer when a control changes. Never touches the transform, so the
    // current zoom/pan survives growing the cloud or dragging the declutter radius.
    render: (options) => {
      const count = 2 ** ((options.nodes as number) ?? 6);
      const declutterPx = (options.declutter as number) ?? 30;
      const showLabels = (options.labels ?? "on") !== "off";

      // Sort by importance DESC: declutter keeps the earliest-listed of any overlapping group,
      // so listing the big nodes first makes them win. (Glyph priority = input order.)
      const nodes = makeNodes(count, W, H).sort((a, b) => b.importance - a.importance);

      chart.layer("nodes", nodes, {
        draw: (ctx, d) => {
          ctx.moveTo(d.x + d.radius, d.y);
          ctx.arc(d.x, d.y, d.radius, 0, 2 * Math.PI);
          ctx.closePath();
        },
        fill: (d: Node) => color(d.importance),
        stroke: "#ffffff",
        lineWidth: 1,
        anchor: (d: Node) => [d.x, d.y], // pin each node; screen mode keeps it constant-size
        sizeMode: "screen",
        // The star of the example: 0 disables, any +px hides circles whose anchors collide.
        declutter: declutterPx > 0 ? declutterPx : undefined,
        id: (d: Node) => d.id,
        hover: { stroke: "#111", lineWidth: 2 },
        tooltip: (d: Node) => nodeTooltip(d),
      });
      chart.render();

      // One label per node, placed just past its right edge. `importanceOf` drives label culling:
      // higher importance survives a collision (matching the glyph order above). The engine measures
      // each label once and re-places them on every zoom/pan. The **Labels** toggle removes them
      // (`false`) to isolate the d3gl glyph-declutter + GPU path at high node counts.
      if (showLabels) chart.labels(nodes, {
        labelOf: (d) => d.label,
        anchorOf: (d) => [d.x, d.y],
        importanceOf: (d) => d.importance,
        offset: (d) => [d.radius + GAP, 0], // right of the circle, vertically centred by the engine
        style: LABEL_STYLE,
      });
      else chart.labels(false);
    },
  };
};
