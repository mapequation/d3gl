import { geoNaturalEarth1 } from "d3-geo";
import { GeoMap } from "@mapequation/d3gl/react";
import { fitProjection } from "@mapequation/d3gl/geo";
import { ResizableBox } from "../../components/ResizableBox.js";
import { addWorld } from "./world.js";

const WIDTH = 320;
const HEIGHT = 200;

/**
 * Fixed mode — pass both `width` and `height`. The map is a static pixel box; it ignores
 * its container, so as you drag the (larger) parent it stays put. This is the opt-out from
 * responsive sizing (the pre-responsive behavior).
 */
export default function FixedSize() {
  return (
    <ResizableBox resize="both" initialWidth={440} initialHeight={300} label="resizable parent (the map ignores it)">
      <GeoMap
        width={WIDTH}
        height={HEIGHT}
        backend="canvas"
        projection={fitProjection(geoNaturalEarth1(), { type: "Sphere" }, WIDTH, HEIGHT)}
        onReady={addWorld}
      />
    </ResizableBox>
  );
}
