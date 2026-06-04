import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

export interface PhyloTreeProps {
  /** Size mode: "world" (radii scale with zoom) or "screen" (constant pixels). */
  coords?: "world" | "screen";
}

/** Harness wrapper: the 64-tip phylogram, in world- or screen-space coordinates. */
export default function PhyloTree({ coords = "world" }: PhyloTreeProps) {
  return (
    <Example defaults={{ coords }} width={900} height={560}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
