import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness wrapper: hover-highlight + multi-select on a `plot` scatter — hover/tooltip
 *  and the `on("select")` gesture (plain click = replace, shift/cmd = add/remove). */
export default function PlotHighlight() {
  return (
    <Example width={900} height={450}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
