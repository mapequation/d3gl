import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Self-links drawn as loops on a small directed network. Switch the link style and the sizing mode. */
export default function SelfLinks() {
  return (
    <Example
      controls={[
        { type: "segmented", key: "style", label: "Style", options: ["Half-arrow", "Arrow"] },
        { type: "segmented", key: "sizing", label: "Sizing", options: ["World", "Screen"] },
      ]}
      width={720}
      height={440}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
