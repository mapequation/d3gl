import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  Backend,
  ControlSpec,
  ExampleContext,
  ExampleEngine,
} from "../examples/types.js";

// ---------------------------------------------------------------------------
// Themed control primitives. These intentionally do NOT import the starwind
// Astro components (they can't render inside a React island); they reproduce the
// starwind look with the same global theme tokens (bg-muted / text-foreground /
// border-border, active = bg-primary text-primary-foreground).
// ---------------------------------------------------------------------------

const SEG_BASE =
  "inline-flex h-6 items-center justify-center px-2 py-0.5 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-outline/50";

/** A joined segmented switch (shared borders, equal height); active = primary. */
function Segmented<T extends string>(props: {
  label?: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  const { label, value, options, onChange } = props;
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="text-muted-foreground text-[11px]">{label}</span>}
      <div role="group" aria-label={label} className="inline-flex isolate">
        {options.map((opt, i) => {
          const active = opt === value;
          const round =
            i === 0
              ? "rounded-l-md"
              : i === options.length - 1
                ? "rounded-r-md"
                : "";
          return (
            <button
              key={opt}
              type="button"
              data-active={active ? "" : undefined}
              aria-pressed={active}
              onClick={() => onChange(opt)}
              className={[
                SEG_BASE,
                round,
                "-ml-px first:ml-0 border border-border",
                active
                  ? "bg-primary text-primary-foreground border-primary z-10 hover:bg-primary"
                  : "bg-background text-foreground hover:bg-muted",
              ].join(" ")}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A primary action button matching the starwind outline-button height. */
function ActionButton(props: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex h-6 items-center justify-center rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-outline/50"
    >
      {props.children}
    </button>
  );
}

/** A range slider with a live value label, committing on release. */
function RangeSlider(props: {
  spec: Extract<ControlSpec, { type: "range" }>;
  value: number;
  onCommit: (v: number) => void;
}) {
  const { spec } = props;
  const [live, setLive] = useState(props.value);
  useEffect(() => setLive(props.value), [props.value]);
  const display = spec.display?.[(live - spec.min) / spec.step] ?? String(live);
  return (
    <div className="flex h-6 items-center gap-1.5">
      <span className="text-muted-foreground text-[11px]">
        {spec.label} {display}
      </span>
      <input
        type="range"
        className="accent-primary h-1 w-32"
        aria-label={spec.label}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={live}
        onChange={(e) => setLive(Number(e.target.value))}
        onPointerUp={() => props.onCommit(live)}
        onKeyUp={() => props.onCommit(live)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Perf readout — a small React reimplementation of createPerfMeter so it lives
// inside the React tree (no querySelector). Same fps / frame-ms / heap layout.
// ---------------------------------------------------------------------------

interface MemoryInfo {
  usedJSHeapSize: number;
}

function PerfMeter() {
  const [fps, setFps] = useState(0);
  const [ms, setMs] = useState(0);
  const [heap, setHeap] = useState<number | null>(null);
  useEffect(() => {
    let last = 0,
      frames = 0,
      acc = 0,
      report = 0,
      raf = 0;
    const tick = (now: number): void => {
      if (last === 0) {
        last = now;
        report = now;
      }
      const dt = now - last;
      last = now;
      frames += 1;
      acc += dt;
      if (now - report >= 500) {
        setFps(Math.round((frames * 1000) / (now - report)));
        setMs(Math.round((acc / frames) * 10) / 10);
        const mem = (performance as unknown as { memory?: MemoryInfo }).memory;
        if (mem) setHeap(Math.round(mem.usedJSHeapSize / 1048576));
        frames = 0;
        acc = 0;
        report = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const num = "text-foreground [font-variant-numeric:tabular-nums]";
  return (
    <div className="ml-auto flex gap-2.5 font-mono text-xs text-muted-foreground">
      <span>
        fps <b className={num}>{fps}</b>
      </span>
      <span>
        frame <b className={num}>{ms}</b> ms
      </span>
      {heap !== null && (
        <span>
          heap <b className={num}>{heap}</b> MB
        </span>
      )}
    </div>
  );
}

/** Trigger a browser download of a data URL or string payload. */
function download(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
}

const BACKENDS: readonly Backend[] = ["webgl", "canvas", "svg"];

export interface ExampleProps {
  controls?: ControlSpec[];
  defaults?: Record<string, unknown>;
  width?: number;
  height?: number;
  children: (ctx: ExampleContext) => ReactNode;
}

/**
 * The universal live-example harness. ALL plumbing lives here and flows through
 * React state / refs and the `ctx` it hands the render-prop child — there is no
 * querySelector, no `data-*` reads, and no CustomEvents. The viz receives
 * `ctx.backend` / `ctx.width` / `ctx.height` / `ctx.options` and reacts to them;
 * backend switching is the viz's responsibility (so the harness never remounts on
 * backend change and zoom/pan is preserved).
 */
export default function Example(props: ExampleProps) {
  const { controls = [], defaults = {}, width = 900, height = 560, children } = props;

  const initialBackend = (defaults.backend as Backend) ?? "webgl";
  const [backend, setBackend] = useState<Backend>(initialBackend);

  // Example-specific control values, seeded from each control's default then any
  // page-supplied `defaults`.
  const [options, setOptions] = useState<Record<string, unknown>>(() => {
    const o: Record<string, unknown> = {};
    for (const c of controls) {
      o[c.key] =
        c.type === "range" ? c.value : c.type === "select" ? (c.value ?? c.options[0]) : c.options[0];
    }
    for (const [k, v] of Object.entries(defaults)) if (k !== "backend") o[k] = v;
    return o;
  });

  // Measure the canvas container so the viz renders 1:1 at the container size.
  const canvasRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width, height });
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w < 2) return;
      setSize((prev) =>
        Math.abs(prev.width - w) < 2 && Math.abs(prev.height - h) < 2 ? prev : { width: w, height: h },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The engine the viz registers, used for export.
  const engineRef = useRef<ExampleEngine | null>(null);
  const registerEngine = (engine: ExampleEngine): void => {
    engineRef.current = engine;
  };

  const selects = controls.filter((c) => c.type === "select") as Extract<
    ControlSpec,
    { type: "select" }
  >[];
  const segmented = controls.filter((c) => c.type !== "range" && c.type !== "select") as Extract<
    ControlSpec,
    { options: string[] }
  >[];
  const ranges = controls.filter((c) => c.type === "range") as Extract<
    ControlSpec,
    { type: "range" }
  >[];
  const hasControlsRow = segmented.length > 0 || ranges.length > 0 || selects.length > 0;

  const onExport = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    if (backend === "svg") {
      download(
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(engine.toSVG())}`,
        "example.svg",
      );
    } else {
      download(engine.toPNG(), "example.png");
    }
  };

  const ctx: ExampleContext = {
    backend,
    width: size.width,
    height: size.height,
    options,
    registerEngine,
  };

  return (
    <div className="d3gl-live bg-card text-foreground">
      {/* Status row: backend switch (left), export, perf (right). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <Segmented value={backend} options={BACKENDS} onChange={setBackend} />
        <ActionButton onClick={onExport}>
          {backend === "svg" ? "Export SVG" : "Export PNG"}
        </ActionButton>
        <PerfMeter />
      </div>

      {hasControlsRow && (
        <>
          <div className="px-3 pb-1">
            <div className="border-border h-px w-24 border-t" />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 pt-1.5 pb-2.5">
            {segmented.map((c) => (
              <Segmented
                key={c.key}
                label={c.label}
                value={String(options[c.key]) as string}
                options={c.options}
                onChange={(v) => setOptions((o) => ({ ...o, [c.key]: v }))}
              />
            ))}
            {ranges.map((c) => (
              <RangeSlider
                key={c.key}
                spec={c}
                value={Number(options[c.key])}
                onCommit={(v) => setOptions((o) => ({ ...o, [c.key]: v }))}
              />
            ))}
            {selects.map((c) => (
              <label key={c.key} className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-[11px]">{c.label}</span>
                <select
                  className="border-border bg-background text-foreground focus-visible:ring-outline/50 h-6 rounded-md border px-1.5 text-[11px] outline-none focus-visible:ring-2"
                  value={String(options[c.key])}
                  onChange={(e) => setOptions((o) => ({ ...o, [c.key]: e.target.value }))}
                >
                  {c.options.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </>
      )}

      <div
        ref={canvasRef}
        className="d3gl-canvas relative w-full bg-white"
        style={{ maxWidth: width, height }}
      >
        {children(ctx)}
      </div>
    </div>
  );
}
