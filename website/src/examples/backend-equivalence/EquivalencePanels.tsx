import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { plot, type Plot } from "@mapequation/d3gl/map";
import type { ViewTransform } from "@mapequation/d3gl";
import type { Backend } from "../types.js";
import { ErrorBoundary } from "../../components/ErrorBoundary.js";

const PANELS: { backend: Exclude<Backend, "auto">; label: string }[] = [
  { backend: "webgl", label: "WebGL" },
  { backend: "canvas", label: "Canvas" },
  { backend: "svg", label: "SVG" },
];

const GAP = 12; // px, matches gap-3 between panels
const MIN_PANEL = 120;
const MAX_PANEL = 420;

/** Largest square panel size that fits three across `containerWidth` (with two gaps). */
function panelSizeFor(containerWidth: number): number {
  const s = Math.floor((containerWidth - 2 * GAP) / 3);
  return Math.max(MIN_PANEL, Math.min(MAX_PANEL, s));
}

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
  const rowRef = useRef<HTMLDivElement>(null);
  const hosts = useRef<(HTMLDivElement | null)[]>([]);
  const engines = useRef<Plot[]>([]);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // Square panel size, measured to fill the card width (three across). Starts at 0 so the
  // engines are built once, after the layout effect measures the real width.
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    if (rowRef.current) setSize(panelSizeFor(rowRef.current.clientWidth));
  }, []);

  // Build the three engines once the panel size is known; zoom/pan on any panel mirrors to
  // the others. Rebuilds if the measured size changes.
  useEffect(() => {
    if (!size) return;
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
      const chart = plot(host, { width: size, height: size, backend });
      chart.enableZoom([0.5, 40], (t) => sync(chart, t));
      drawRef.current(chart, size, size);
      es.push(chart);
    });
    engines.current = es;
    return () => {
      for (const e of es) e.destroy();
      engines.current = [];
    };
  }, [size]);

  // Re-draw on the existing engines when a control (renderKey) changes — no recreate, so the
  // user's zoom/pan is preserved. (A redundant run right after the build is harmless: drawing
  // replaces the layer in place. Before the engines exist, engines.current is empty → no-op.)
  useEffect(() => {
    for (const e of engines.current) drawRef.current(e, size, size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <div ref={rowRef} className="flex flex-wrap gap-3">
        {PANELS.map(({ backend, label }, i) => (
          <div key={backend} className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px]">{label}</span>
            <div
              ref={(el) => { hosts.current[i] = el; }}
              className="border-border rounded-md border"
              style={{ width: size || MIN_PANEL, height: size || MIN_PANEL }}
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
