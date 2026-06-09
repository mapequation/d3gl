import { useEffect, useRef } from "react";
import { plot, type Plot } from "@mapequation/d3gl/map";
import type { ViewTransform } from "@mapequation/d3gl";
import type { Backend } from "../types.js";
import { drawEquivalenceScene } from "./draw.js";

const PANELS: { backend: Exclude<Backend, "auto">; label: string }[] = [
  { backend: "webgl", label: "WebGL" },
  { backend: "canvas", label: "Canvas" },
  { backend: "svg", label: "SVG" },
];

const PANEL = 196; // px, square panels — three fit in one row within the docs content column

/**
 * Side-by-side backend-equivalence harness for issue #41: the SAME overlapping
 * bordered-shapes scene rendered in WebGL, Canvas, and SVG at once, so a
 * compositing divergence is visible at a glance. Zoom/pan on any panel mirrors
 * to the others, so all three always show the same view. This is the visual
 * counterpart to the pixel-diff browser test.
 */
export default function BackendEquivalence() {
  const hostRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const engines: Plot[] = [];
    let syncing = false;
    const syncFrom = (src: Plot, t: ViewTransform): void => {
      if (syncing) return;
      syncing = true;
      for (const e of engines) if (e !== src) e.setTransform(t);
      syncing = false;
    };

    PANELS.forEach(({ backend }, i) => {
      const host = hostRefs.current[i];
      if (!host) return;
      const chart = plot(host, { width: PANEL, height: PANEL, backend });
      chart.enableZoom([0.5, 40], (t) => syncFrom(chart, t));
      drawEquivalenceScene(chart, PANEL, PANEL);
      engines.push(chart);
    });

    return () => {
      for (const e of engines) e.destroy();
    };
  }, []);

  return (
    <div className="d3gl-live bg-card text-foreground p-3">
      <div className="flex flex-wrap gap-3">
        {PANELS.map(({ backend, label }, i) => (
          <div key={backend} className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[11px] font-medium">{label}</span>
            <div
              ref={(el) => {
                hostRefs.current[i] = el;
              }}
              className="border-border rounded-md border"
              style={{ width: PANEL, height: PANEL }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
