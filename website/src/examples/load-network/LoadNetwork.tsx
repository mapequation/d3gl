import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness for the load-from-file network example: a file picker (.net / edge list) + sample
 *  buttons live in the canvas overlay; vertex labels render via the HTML LabelLayer. */
export default function LoadNetwork() {
  return (
    <Example controls={[]} width={760} height={480}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
