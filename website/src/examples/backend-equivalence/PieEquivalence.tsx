import StyledEquivalence from "./StyledEquivalence.js";
import { drawPieScene } from "./draw.js";

/** A low-poly translucent pie + rays — shows WebGL's stroke compositing differences (#41). */
export default function PieEquivalence() {
  return <StyledEquivalence draw={drawPieScene} />;
}
