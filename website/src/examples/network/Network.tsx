import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness for the raw-network example: a node-count slider and a Directed/Undirected toggle.
 *  Rendering is WebGL-instanced (points + lines + arrowheads); scroll to zoom, drag to pan. */
export default function Network() {
  return (
    <Example
      controls={[
        { type: "range", key: "nodes", label: "Nodes", min: 6, max: 60, step: 1, value: 24 },
        { type: "segmented", key: "mode", label: "Links", options: ["Directed", "Undirected"] },
      ]}
      width={760}
      height={480}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
