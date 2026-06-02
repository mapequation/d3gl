import React, { useEffect, useRef, useState } from "react";
import { Bioregions } from "./examples/Bioregions.js";
import { PhyloTree } from "./examples/PhyloTree.js";
import { AncestralRanges } from "./examples/AncestralRanges.js";

type ExampleId = "bioregions" | "phylotree" | "ancestral";

interface Example {
  id: ExampleId;
  label: string;
}

const EXAMPLES: Example[] = [
  { id: "bioregions", label: "Bioregions" },
  { id: "phylotree", label: "Phylogenetic tree" },
  { id: "ancestral", label: "Ancestral ranges" },
];

export function App(): React.ReactElement {
  const [selected, setSelected] = useState<ExampleId>("bioregions");

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#ffffff", color: "#222" }}>
      {/* Left drawer */}
      <nav style={{
        width: 200,
        minWidth: 200,
        background: "#f6f7f9",
        borderRight: "1px solid #e2e2e2",
        padding: "16px 0",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}>
        <div style={{ padding: "0 16px 12px", fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", color: "#999", textTransform: "uppercase" }}>
          d3gl examples
        </div>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.id}
            onClick={() => setSelected(ex.id)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 16px",
              textAlign: "left",
              background: selected === ex.id ? "#e8f0fe" : "transparent",
              color: selected === ex.id ? "#1a73e8" : "#444",
              border: "none",
              borderLeft: selected === ex.id ? "3px solid #1a73e8" : "3px solid transparent",
              cursor: "pointer",
              fontSize: 14,
              fontFamily: "inherit",
            }}
          >
            {ex.label}
          </button>
        ))}
        <Stats />
      </nav>

      {/* Main content area */}
      <main style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
        {selected === "bioregions" && <Bioregions />}
        {selected === "phylotree" && <PhyloTree />}
        {selected === "ancestral" && <AncestralRanges />}
      </main>
    </div>
  );
}

interface MemoryInfo { usedJSHeapSize: number; }

/**
 * A live performance readout (pinned to the bottom of the sidebar). A
 * requestAnimationFrame loop measures the realized frame rate and frame time, so
 * heavy renders during pan/zoom (e.g. a 100k-cell grid) show up as a dropping FPS.
 * JS heap is shown when available (Chromium's non-standard performance.memory).
 */
function Stats(): React.ReactElement {
  const [fps, setFps] = useState(0);
  const [ms, setMs] = useState(0);
  const [heapMB, setHeapMB] = useState<number | null>(null);
  const ref = useRef({ last: 0, frames: 0, acc: 0, report: 0 });

  useEffect(() => {
    let raf = 0;
    const tick = (now: number): void => {
      const s = ref.current;
      if (s.last === 0) { s.last = now; s.report = now; }
      const dt = now - s.last;
      s.last = now;
      s.frames += 1;
      s.acc += dt;
      if (now - s.report >= 500) {
        setFps(Math.round((s.frames * 1000) / (now - s.report)));
        setMs(Math.round((s.acc / s.frames) * 10) / 10);
        const mem = (performance as unknown as { memory?: MemoryInfo }).memory;
        if (mem) setHeapMB(Math.round(mem.usedJSHeapSize / 1048576));
        s.frames = 0; s.acc = 0; s.report = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const row = (label: string, value: string, warn = false): React.ReactElement => (
    <div style={{ display: "flex", justifyContent: "space-between", color: warn ? "#d9480f" : "#333" }}>
      <span style={{ color: "#999" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{value}</span>
    </div>
  );

  return (
    <div style={{ marginTop: "auto", padding: "12px 16px", borderTop: "1px solid #e2e2e2", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: "#999", textTransform: "uppercase", marginBottom: 2 }}>stats</div>
      {row("fps", String(fps), fps > 0 && fps < 30)}
      {row("frame", `${ms} ms`)}
      {heapMB != null && row("heap", `${heapMB} MB`)}
    </div>
  );
}
