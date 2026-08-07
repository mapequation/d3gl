import { EquivalencePanels } from "./EquivalencePanels.js";
import { drawRoundedScene } from "./draw.js";

/** Rounded bars (ctx.arcTo tangent arcs) rendered in all three backends. */
export default function RoundedEquivalence() {
  return <EquivalencePanels draw={(chart, w, h) => drawRoundedScene(chart, w, h)} />;
}
