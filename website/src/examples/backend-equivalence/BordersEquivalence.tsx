import { EquivalencePanels } from "./EquivalencePanels.js";
import { drawBordersScene } from "./draw.js";

/** Overlapping bordered shapes rendered in all three backends — the draw-order probe. */
export default function BordersEquivalence() {
  return <EquivalencePanels draw={(chart, w, h) => drawBordersScene(chart, w, h)} />;
}
