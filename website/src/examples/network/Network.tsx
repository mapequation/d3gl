import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness for the raw-network example: a node-count slider and a Directed/Undirected toggle.
 *  Rendering is WebGL-instanced (points + lines + arrowheads); scroll to zoom, drag to pan. */
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
        { type: "segmented", key: "seeding", label: "Seeding", options: ["Multilevel", "Cold"] },
      ]}
      width={760}
      height={480}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
