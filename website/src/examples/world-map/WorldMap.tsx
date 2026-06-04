import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness wrapper: the live world map driven by the universal <Example>. */
export default function WorldMap() {
  return (
    <Example width={720} height={380}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
