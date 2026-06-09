import { useEffect, useRef, useState } from "react";
import { plot, type Plot } from "@mapequation/d3gl/map";
import type { ViewTransform } from "@mapequation/d3gl";
import type { Backend } from "../types.js";
import { drawEquivalenceScene, drawJoinsScene, type JoinStyle } from "./draw.js";

const PANELS: { backend: Exclude<Backend, "auto">; label: string }[] = [
  { backend: "webgl", label: "WebGL" },
  { backend: "canvas", label: "Canvas" },
  { backend: "svg", label: "SVG" },
];

const PANEL = 196; // px, square panels — three fit in one row within the docs content column

const SEG =
  "inline-flex h-6 items-center justify-center border border-border px-2 text-[11px] font-medium -ml-px first:ml-0 first:rounded-l-md last:rounded-r-md outline-none";

/** A small segmented control matching the live-example harness look. */
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex isolate">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`${SEG} ${opt === value ? "bg-primary text-primary-foreground border-primary z-10" : "bg-background text-foreground hover:bg-muted"}`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

/**
 * Side-by-side backend-equivalence harness for issue #41: the SAME scene rendered in
 * WebGL, Canvas, and SVG at once, so a compositing divergence is visible at a glance.
 * Row 1 (overlapping borders) probes draw order; row 2 (thick polylines) probes stroke
 * joins/caps and has live join/cap/miter-limit controls. Zoom/pan on any panel mirrors
 * to every other panel. Visual counterpart to the pixel-diff browser tests.
 */
export default function BackendEquivalence() {
  const borderHosts = useRef<(HTMLDivElement | null)[]>([]);
  const joinHosts = useRef<(HTMLDivElement | null)[]>([]);
  const joinEngines = useRef<Plot[]>([]);
  const [style, setStyle] = useState<JoinStyle>({ lineJoin: "miter", lineCap: "butt", miterLimit: 10 });

  // Build all engines once; mirror zoom/pan across every panel.
  useEffect(() => {
    const engines: Plot[] = [];
    let syncing = false;
    const syncFrom = (src: Plot, t: ViewTransform): void => {
      if (syncing) return;
      syncing = true;
      for (const e of engines) if (e !== src) e.setTransform(t);
      syncing = false;
    };
    const make = (host: HTMLDivElement | null, backend: Exclude<Backend, "auto">): Plot | null => {
      if (!host) return null;
      const chart = plot(host, { width: PANEL, height: PANEL, backend });
      chart.enableZoom([0.5, 40], (t) => syncFrom(chart, t));
      engines.push(chart);
      return chart;
    };
    PANELS.forEach(({ backend }, i) => {
      const b = make(borderHosts.current[i], backend);
      if (b) drawEquivalenceScene(b, PANEL, PANEL);
    });
    joinEngines.current = PANELS.map(({ backend }, i) => make(joinHosts.current[i], backend)).filter((e): e is Plot => !!e);

    return () => {
      for (const e of engines) e.destroy();
      joinEngines.current = [];
    };
  }, []);

  // Re-render the joins row whenever a style control changes (re-builds the layer only).
  useEffect(() => {
    for (const e of joinEngines.current) drawJoinsScene(e, PANEL, PANEL, style);
  }, [style]);

  const panelRow = (hosts: typeof borderHosts) => (
    <div className="flex flex-wrap gap-3">
      {PANELS.map(({ backend, label }, i) => (
        <div key={backend} className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px]">{label}</span>
          <div
            ref={(el) => { hosts.current[i] = el; }}
            className="border-border rounded-md border"
            style={{ width: PANEL, height: PANEL }}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div className="d3gl-live bg-card text-foreground p-3">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[11px] font-medium">Overlapping bordered shapes (draw order)</span>
          {panelRow(borderHosts)}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[11px] font-medium">Stroke joins & caps</span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-[11px]">Join</span>
              <Segmented value={style.lineJoin} options={["miter", "bevel"] as const} onChange={(lineJoin) => setStyle((s) => ({ ...s, lineJoin }))} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-[11px]">Cap</span>
              <Segmented value={style.lineCap} options={["butt", "square", "round"] as const} onChange={(lineCap) => setStyle((s) => ({ ...s, lineCap }))} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-[11px]">Miter limit {style.miterLimit}</span>
              <input
                type="range"
                className="accent-primary h-1 w-28"
                min={1}
                max={20}
                step={1}
                value={style.miterLimit}
                disabled={style.lineJoin !== "miter"}
                onChange={(e) => setStyle((s) => ({ ...s, miterLimit: Number(e.target.value) }))}
              />
            </label>
          </div>
          {panelRow(joinHosts)}
        </div>
      </div>
    </div>
  );
}
