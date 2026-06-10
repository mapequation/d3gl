import StyledEquivalence from "./StyledEquivalence.js";
import { drawJoinsScene } from "./draw.js";

/** Thick opaque polylines (zigzag, acute spike, closed triangle) — the stroke join + cap probe. */
export default function JoinsEquivalence() {
  return <StyledEquivalence draw={drawJoinsScene} />;
}
