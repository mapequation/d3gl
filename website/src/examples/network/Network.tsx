import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness for the raw-network example: a node-count slider, Directed/Undirected and uniform/
 *  degree-weighted node-size toggles, and a seeding toggle. Rendering is WebGL-instanced (points +
 *  lines + arrowheads); scroll to zoom, drag to pan. */
export default function Network() {
  return (
    <Example
      controls={[
        {
          type: "range",
          key: "nodes",
          label: "Nodes",
          min: 0,
          max: 5,
          step: 1,
          value: 2, // 1k — a good default for showing LOD; crank up to stress-test
          display: ["10", "100", "1k", "10k", "100k", "1M"],
        },
        { type: "segmented", key: "mode", label: "Links", options: ["Directed", "Undirected"] },
        { type: "segmented", key: "size", label: "Node size", options: ["Uniform", "Degree"], value: "Degree" },
        { type: "segmented", key: "edge", label: "Edge size", options: ["Uniform", "Weight"], value: "Weight" },
        { type: "segmented", key: "coords", label: "Sizing", options: ["World", "Screen"], value: "Screen" },
        { type: "segmented", key: "lod", label: "LOD", options: ["Off", "On"], value: "On" },
        { type: "segmented", key: "declutter", label: "Declutter", options: ["On", "Off"] },
        { type: "segmented", key: "edges", label: "Edges", options: ["On", "Off"] },
        { type: "segmented", key: "crossLevel", label: "Cross-level edges", options: ["Off", "On"], value: "On" },
        {
          type: "range",
          key: "crossFade",
          label: "Cross-fade",
          min: 0,
          max: 6,
          step: 1,
          value: 0, // off; raise to fade aggregates ↔ children across the expand threshold
          display: ["Off", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6"],
        },
        { type: "segmented", key: "seeding", label: "Seeding", options: ["Multilevel", "Cold"] },
      ]}
      width={760}
      height={480}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
