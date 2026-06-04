import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness wrapper: every GeoJSON geometry type on one map, with HTML city labels. */
export default function GeoJsonFeatures() {
  return (
    <Example width={900} height={450}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
