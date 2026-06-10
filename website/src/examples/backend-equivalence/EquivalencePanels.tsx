import { useEffect, useRef, useState, type ReactNode } from "react";
import { plot, type Plot } from "@mapequation/d3gl/map";
import type { ViewTransform } from "@mapequation/d3gl";
import type { Backend } from "../types.js";
import { ErrorBoundary } from "../../components/ErrorBoundary.js";

const PANELS: { backend: Exclude<Backend, "auto">; label: string }[] = [
  { backend: "webgl", label: "WebGL" },
  { backend: "canvas", label: "Canvas" },
  { backend: "svg", label: "SVG" },
];

const PANEL = 196; // px, square panels — three fit in one row within the docs content column

/** Circular-arrow restart glyph (mirrors the live-example harness). */
function RestartIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: "scaleX(-1)" }}>
      <path d="M3 13.2a9 9 0 1 0 3-7.2L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function Panels({ draw, renderKey, controls, onReload }: {
  draw: (chart: Plot, w: number, h: number) => void;
  renderKey?: unknown;
  controls?: ReactNode;
  onReload: () => void;
}) {
  const hosts = useRef<(HTMLDivElement | null)[]>([]);
  const engines = useRef<Plot[]>([]);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // The create effect already draws with the initial renderKey, so the renderKey effect
  // skips its first (mount) run and only re-draws on subsequent control changes.
  const skipNextRedraw = useRef(true);

  // Build the three engines once per mount; zoom/pan on any panel mirrors to the others.
  useEffect(() => {
    const es: Plot[] = [];
    let syncing = false;
    const sync = (src: Plot, t: ViewTransform): void => {
      if (syncing) return;
      syncing = true;
      for (const e of es) if (e !== src) e.setTransform(t);
      syncing = false;
    };
    PANELS.forEach(({ backend }, i) => {
      const host = hosts.current[i];
      if (!host) return;
      const chart = plot(host, { width: PANEL, height: PANEL, backend });
      chart.enableZoom([0.5, 40], (t) => sync(chart, t));
      drawRef.current(chart, PANEL, PANEL);
      es.push(chart);
    });
    engines.current = es;
    return () => {
      for (const e of es) e.destroy();
      engines.current = [];
    };
  }, []);

  // Re-draw on the existing engines when a control (renderKey) changes — no recreate, so
  // the user's zoom/pan is preserved.
  useEffect(() => {
    if (skipNextRedraw.current) { skipNextRedraw.current = false; return; }
    for (const e of engines.current) drawRef.current(e, PANEL, PANEL);
  }, [renderKey]);

  return (
    <div className="d3gl-live bg-card text-foreground p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {controls}
        <button
          type="button"
          onClick={onReload}
          title="Reset zoom"
          aria-label="Reset zoom"
          className="border-border bg-background text-foreground hover:bg-muted focus-visible:ring-outline/50 ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md border outline-none transition-colors focus-visible:ring-2"
        >
          <RestartIcon />
        </button>
      </div>
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
    </div>
  );
}

/**
 * Three backend panels (WebGL/Canvas/SVG) rendering the same scene with mirrored zoom/pan,
 * an ErrorBoundary, and a reset-zoom button — the shared shell for the equivalence examples.
 * `renderKey` re-draws the scene in place when controls change; the reset button remounts to
 * recreate the engines at the identity view (and recovers from any error).
 */
export function EquivalencePanels(props: {
  draw: (chart: Plot, w: number, h: number) => void;
  renderKey?: unknown;
  controls?: ReactNode;
}) {
  const [resetKey, setResetKey] = useState(0);
  const reload = (): void => setResetKey((k) => k + 1);
  return (
    <ErrorBoundary key={resetKey} onReset={reload}>
      <Panels draw={props.draw} renderKey={props.renderKey} controls={props.controls} onReload={reload} />
    </ErrorBoundary>
  );
}
