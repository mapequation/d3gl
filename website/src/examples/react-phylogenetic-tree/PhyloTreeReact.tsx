import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "../phylogenetic-tree/draw.js";

/**
 * Driving the imperative `plot` engine from React. The `<Imperative>` helper IS
 * the React-effect pattern: a mount effect runs `setup(host, …)` to build the
 * chart and register it for export, a `[backend]` effect calls
 * `chart.setBackend()` so switching backend preserves the current zoom/pan, and
 * cleanup tears it down with `chart.destroy()`. The viz logic stays in the pure
 * d3gl `draw.ts` shared with the vanilla phylogenetic-tree example — no
 * `<GeoMap>` wrapper, just the engine in an effect.
 */
export default function PhyloTreeReact() {
  return (
    <Example defaults={{ coords: "world" }} width={720} height={460}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
