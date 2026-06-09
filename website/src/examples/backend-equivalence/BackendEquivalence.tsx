import { useEffect, useRef } from "react";
import { plot, type Plot } from "@mapequation/d3gl/map";
import type { ViewTransform } from "@mapequation/d3gl";
import type { Backend } from "../types.js";
import { drawEquivalenceScene, drawJoinsScene } from "./draw.js";

const PANELS: { backend: Exclude<Backend, "auto">; label: string }[] = [
  { backend: "webgl", label: "WebGL" },
  { backend: "canvas", label: "Canvas" },
  { backend: "svg", label: "SVG" },
];

/** Each row is one scene rendered across all three backends. */
const SCENES: { key: string; label: string; draw: (chart: Plot, w: number, h: number) => void }[] = [
  { key: "borders", label: "Overlapping bordered shapes (draw order)", draw: drawEquivalenceScene },
  { key: "joins", label: "Stroke joins & caps (miter limit)", draw: drawJoinsScene },
];

const PANEL = 196; // px, square panels — three fit in one row within the docs content column

/**
 * Side-by-side backend-equivalence harness for issue #41: the SAME scene rendered in
 * WebGL, Canvas, and SVG at once, so a compositing divergence is visible at a glance.
 * One row per probe scene (overlapping borders → draw order; stroke joins/caps → miter).
 * Zoom/pan on any panel mirrors to every other panel (all rows), so all views match.
 * This is the visual counterpart to the pixel-diff browser tests.
 */
export default function BackendEquivalence() {
  // hostRefs[sceneIndex][panelIndex]
  const hostRefs = useRef<(HTMLDivElement | null)[][]>(SCENES.map(() => []));

  useEffect(() => {
    const engines: Plot[] = [];
    let syncing = false;
    const syncFrom = (src: Plot, t: ViewTransform): void => {
      if (syncing) return;
      syncing = true;
      for (const e of engines) if (e !== src) e.setTransform(t);
      syncing = false;
    };

    SCENES.forEach((scene, si) => {
      PANELS.forEach(({ backend }, pi) => {
        const host = hostRefs.current[si]![pi];
        if (!host) return;
        const chart = plot(host, { width: PANEL, height: PANEL, backend });
        chart.enableZoom([0.5, 40], (t) => syncFrom(chart, t));
        scene.draw(chart, PANEL, PANEL);
        engines.push(chart);
      });
    });

    return () => {
      for (const e of engines) e.destroy();
    };
  }, []);

  return (
    <div className="d3gl-live bg-card text-foreground p-3">
      <div className="flex flex-col gap-4">
        {SCENES.map((scene, si) => (
          <div key={scene.key} className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[11px] font-medium">{scene.label}</span>
            <div className="flex flex-wrap gap-3">
              {PANELS.map(({ backend, label }, pi) => (
                <div key={backend} className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-[10px]">{label}</span>
                  <div
                    ref={(el) => {
                      hostRefs.current[si]![pi] = el;
                    }}
                    className="border-border rounded-md border"
                    style={{ width: PANEL, height: PANEL }}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
