import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness for the state-network example: a View toggle that flips the physical (aggregated network with
 *  overlapping-module pie glyphs) and state (rosette of memory nodes) renderings of one state network. */
export default function StateNetwork() {
  return (
    <Example
      controls={[{ type: "segmented", key: "view", label: "View", options: ["Physical", "State"] }]}
      width={760}
      height={520}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
