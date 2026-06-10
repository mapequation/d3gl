import StyledEquivalence from "./StyledEquivalence.js";
import { drawStrokeScene } from "./draw.js";

/** The same stroke scene at 50% opacity — reveals WebGL's stroke self-overlap (#41). */
export default function TranslucentEquivalence() {
  return <StyledEquivalence draw={(chart, w, h, style) => drawStrokeScene(chart, w, h, 0.5, style)} />;
}
