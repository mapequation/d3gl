import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Which edges the user can drag. "horizontal" leaves the height to the content
   *  (so a width-driven `aspectRatio` map sets its own height). */
  resize?: "both" | "horizontal";
  initialWidth?: number;
  initialHeight?: number;
  minWidth?: number;
  minHeight?: number;
  /** Short caption describing what the box is (e.g. "resizable parent"). */
  label?: string;
}

/**
 * A drag-to-resize container (native CSS `resize`) with a live size readout — demo chrome
 * for the responsive-sizing examples. Lives in `components/` (not `examples/`) so it stays
 * out of the example code tabs. The d3gl engine inside reacts to the box via its own
 * ResizeObserver; this component only reports the box's measured size.
 */
export function ResizableBox({
  children,
  resize = "both",
  initialWidth = 360,
  initialHeight = 220,
  minWidth = 180,
  minHeight = 120,
  label = "resizable container",
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const horizontal = resize === "horizontal";
  const boxStyle: CSSProperties = {
    resize,
    overflow: "hidden",
    width: initialWidth,
    height: horizontal ? undefined : initialHeight,
    minWidth,
    minHeight: horizontal ? undefined : minHeight,
    maxWidth: "100%",
  };

  return (
    <div className="not-content p-3">
      <div ref={ref} className="border-border relative rounded-md border border-dashed bg-white" style={boxStyle}>
        {children}
      </div>
      <p className="text-muted-foreground mt-1.5 text-xs">
        {label} — drag the {horizontal ? "right edge" : "bottom-right corner"} to resize
        {size ? ` · ${size.w} × ${size.h} px` : ""}
      </p>
    </div>
  );
}
