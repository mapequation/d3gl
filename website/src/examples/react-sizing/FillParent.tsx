import { geoNaturalEarth1 } from "d3-geo";
import { GeoMap } from "@mapequation/d3gl/react";
import { fitProjection } from "@mapequation/d3gl/geo";
import { ResizableBox } from "../../components/ResizableBox.js";
import { addWorld } from "./world.js";

const W = 380;
const H = 240;

/**
 * Fill-parent mode — pass no `width`/`height`/`aspectRatio`. The map fills its parent box
 * on both axes (the parent must supply a height). Drag the corner: the engine resizes in
 * place and refits the projection to the new box, so the world keeps filling it.
 */
export default function FillParent() {
  return (
    <ResizableBox resize="both" initialWidth={W} initialHeight={H} label="resizable parent (map fills it)">
      <GeoMap
        backend="canvas"
        projection={fitProjection(geoNaturalEarth1(), { type: "Sphere" }, W, H)}
        onReady={addWorld}
      />
    </ResizableBox>
  );
}
