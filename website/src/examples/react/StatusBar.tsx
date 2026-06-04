import { useEffect, useRef } from "react";
import type { BackendType } from "@mapequation/d3gl/map";
import { createPerfMeter } from "../../components/perf.ts";

const BACKENDS: BackendType[] = ["webgl", "canvas", "svg"];

export interface StatusBarProps {
  backend: BackendType;
  onBackendChange: (b: BackendType) => void;
  onExport: () => void;
  /** Export button label — backend-aware ("Export SVG" for svg, else "Export PNG"). */
  exportLabel?: string;
}

/**
 * A top status bar shared by the React examples, mirroring the vanilla starwind
 * bar: a segmented backend switch on the left, an Export button after it, and a
 * live perf readout on the right. Starwind's Astro components can't render inside
 * a React island, so this is plain React styled with the global theme tokens.
 */
export default function StatusBar({ backend, onBackendChange, onExport, exportLabel }: StatusBarProps) {
  const perfRef = useRef<HTMLDivElement>(null);

  // Reuse the vanilla rAF perf meter: it writes fps/frame/heap into the ref'd div
  // and returns a stop() we call on unmount.
  useEffect(() => {
    const el = perfRef.current;
    if (!el) return;
    return createPerfMeter(el);
  }, []);

  return (
    <div className="flex items-center gap-2.5 border-b border-border bg-muted px-2.5 py-2 text-[13px]">
      <div className="inline-flex items-center overflow-hidden rounded-md border border-border" role="group" aria-label="Rendering backend">
        {BACKENDS.map((b, i) => {
          const active = b === backend;
          return (
            <button
              key={b}
              type="button"
              onClick={() => onBackendChange(b)}
              aria-pressed={active}
              className={[
                "inline-flex h-7 items-center px-2.5 leading-none capitalize",
                i > 0 ? "border-l border-border" : "",
                active ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              ].join(" ")}
            >
              {b}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onExport}
        className="inline-flex h-7 items-center rounded-md border border-border px-2.5 leading-none hover:bg-accent"
      >
        {exportLabel ?? "Export PNG"}
      </button>

      <div ref={perfRef} className="ml-auto" />
    </div>
  );
}
