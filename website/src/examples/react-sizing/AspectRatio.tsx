import { geoNaturalEarth1 } from "d3-geo";
import { GeoMap } from "@mapequation/d3gl/react";
import { fitProjection } from "@mapequation/d3gl/geo";
import { ResizableBox } from "../../components/ResizableBox.js";
import { addWorld } from "./world.js";

const W = 380;
const RATIO = 2; // width ÷ height

/**
 * Aspect-ratio mode — pass `aspectRatio`. The map fills the available width and derives its
 * height from the ratio, so it stays proportional. Drag the right edge (width only): the
 * height tracks automatically and the projection rescales, preserving the framing exactly.
 */
export default function AspectRatio() {
  return (
    <ResizableBox resize="horizontal" initialWidth={W} label="resizable width (height follows the ratio)">
      <GeoMap
        aspectRatio={RATIO}
        backend="canvas"
        projection={fitProjection(geoNaturalEarth1(), { type: "Sphere" }, W, W / RATIO)}
        onReady={addWorld}
      />
    </ResizableBox>
  );
}
