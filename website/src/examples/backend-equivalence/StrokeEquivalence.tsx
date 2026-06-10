import { useState } from "react";
import { EquivalencePanels } from "./EquivalencePanels.js";
import { drawJoinsScene, type JoinStyle } from "./draw.js";

const SEG =
  "inline-flex h-6 items-center justify-center border border-border px-2 text-[11px] font-medium -ml-px first:ml-0 first:rounded-l-md last:rounded-r-md outline-none";

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
 * A pie chart + overlapping rays rendered in all three backends, with live Join / Cap /
 * Miter-limit controls — the stroke join + end-cap probe. All three stay in lockstep for
 * every combination (the default is `bevel`, matching the old WebGL look).
 */
export default function StrokeEquivalence() {
  const [style, setStyle] = useState<JoinStyle>({ lineJoin: "bevel", lineCap: "butt", miterLimit: 10 });
  const controls = (
    <>
      <label className="flex items-center gap-1.5">
        <span className="text-muted-foreground text-[11px]">Join</span>
        <Segmented value={style.lineJoin} options={["bevel", "miter", "round"] as const} onChange={(lineJoin) => setStyle((s) => ({ ...s, lineJoin }))} />
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
    </>
  );
  return (
    <EquivalencePanels
      draw={(chart, w, h) => drawJoinsScene(chart, w, h, style)}
      renderKey={JSON.stringify(style)}
      controls={controls}
    />
  );
}
