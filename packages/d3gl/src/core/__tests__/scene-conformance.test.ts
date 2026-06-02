import { describe, it, expect } from "vitest";
import { geoPath, geoEquirectangular } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { Scene } from "../scene.js";

/** A tiny grid of square cells, each a GeoJSON polygon with a `value`. */
function gridCells(cols: number, rows: number) {
  const cells: { id: string; value: number; geometry: GeoJSON.Polygon }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -180 + (c * 360) / cols;
      const y = -90 + (r * 180) / rows;
      const w = 360 / cols;
      const h = 180 / rows;
      cells.push({
        id: `${c}-${r}`,
        value: Math.random(),
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [x, y],
              [x + w, y],
              [x + w, y + h],
              [x, y + h],
              [x, y],
            ],
          ],
        },
      });
    }
  }
  return cells;
}

describe("Scene conformance with d3-geo", () => {
  it("builds a grid-cell scene from geoPath and packs fill+stroke buffers", () => {
    const cells = gridCells(6, 4); // 24 cells
    const projection = geoEquirectangular();
    const scene = new Scene();
    scene.group("cells", (g) => {
      for (const cell of cells) {
        // geoPath draws INTO the per-drawable recorder context.
        g.drawable(
          cell.id,
          (ctx) => {
            const path = geoPath(projection, ctx);
            path(cell.geometry);
          },
          { lineWidth: 0.5 },
        );
      }
    });
    const buf = scene.buffers("cells");
    expect(buf.drawableCount).toBe(24);
    expect(buf.fillIndices.length).toBeGreaterThanOrEqual(24 * 6); // >=2 triangles/cell
    expect(buf.strokeIndices.length).toBeGreaterThan(0);
    // every fill vertex carries a valid drawableId in [0, 24)
    for (let i = 0; i < buf.fillVertices.length; i += 3) {
      const id = buf.fillVertices[i + 2]!;
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(24);
    }
  });

  it("recoloring with a d3 color scale changes only the color table, not geometry", () => {
    const cells = gridCells(6, 4);
    const projection = geoEquirectangular();
    const scene = new Scene();
    scene.group("cells", (g) => {
      for (const cell of cells) {
        g.drawable(cell.id, (ctx) => geoPath(projection, ctx)(cell.geometry), { lineWidth: 0.5 });
      }
    });

    const geomBefore = Array.from(scene.buffers("cells").fillVertices);

    // Heatmap recolor.
    const color = scaleSequential(interpolateViridis).domain([0, 1]);
    for (const cell of cells) scene.setFill("cells", cell.id, color(cell.value));

    const after = scene.buffers("cells");
    // Geometry byte-for-byte identical after recolor.
    expect(Array.from(after.fillVertices)).toEqual(geomBefore);
    // Color table now has non-transparent entries.
    let nonTransparent = 0;
    for (let i = 0; i < after.fillColors.length; i += 4) {
      if (after.fillColors[i + 3]! > 0) nonTransparent++;
    }
    expect(nonTransparent).toBe(24);
  });
});
