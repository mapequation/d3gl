import StyledEquivalence from "./StyledEquivalence.js";
import { drawStrokeScene } from "./draw.js";

/** The stroke scene at full opacity — a clean join + cap probe (all three backends match). */
export default function JoinsEquivalence() {
  return <StyledEquivalence draw={(chart, w, h, style) => drawStrokeScene(chart, w, h, 1, style)} />;
}
