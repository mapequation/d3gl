import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness wrapper: hover-highlight + click-selection on a `plot` scatter — the same
 *  interaction options as the map Highlight example, on the 2D Cartesian engine. */
export default function PlotHighlight() {
  return (
    <Example width={900} height={450}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
