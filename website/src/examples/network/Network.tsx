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
          value: 1, // 100 — loads instantly; crank up to stress-test
          display: ["10", "100", "1k", "10k", "100k", "1M"],
        },
        { type: "segmented", key: "mode", label: "Links", options: ["Directed", "Undirected"] },
        { type: "segmented", key: "size", label: "Size", options: ["Uniform", "Degree"] },
        { type: "segmented", key: "coords", label: "Sizing", options: ["World", "Screen"] },
        { type: "segmented", key: "lod", label: "LOD", options: ["Off", "On"] },
        { type: "segmented", key: "seeding", label: "Seeding", options: ["Multilevel", "Cold"] },
      ]}
      width={760}
      height={480}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
