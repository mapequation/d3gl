import React, { useState } from "react";
import { Bioregions } from "./examples/Bioregions.js";
import { PhyloTree } from "./examples/PhyloTree.js";

type ExampleId = "bioregions" | "phylotree";

interface Example {
  id: ExampleId;
  label: string;
}

const EXAMPLES: Example[] = [
  { id: "bioregions", label: "Bioregions" },
  { id: "phylotree", label: "Phylogenetic tree" },
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
      </nav>

      {/* Main content area */}
      <main style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
        {selected === "bioregions" && <Bioregions />}
        {selected === "phylotree" && <PhyloTree />}
      </main>
    </div>
  );
}
