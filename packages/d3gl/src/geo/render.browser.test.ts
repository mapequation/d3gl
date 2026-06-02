import { describe, it, expect } from "vitest";
import { geoNaturalEarth1 } from "d3-geo";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Scene } from "../core/index.js";
import { GroupRenderer, clipFromView } from "../webgl/index.js";
import { fitProjection, featureGroup } from "./project.js";

const W = 256;
const H = 256;

function gridCells(step: number): { id: string; geometry: Polygon; value: number }[] {
  const cells: { id: string; geometry: Polygon; value: number }[] = [];
  let col = 0;
  // Inset away from the antimeridian (lon ±180) and poles (lat ±90) to avoid
  // d3-geo spherical cutting turning seam/pole cells into giant wrapping polygons.
  for (let lon = -176; lon < 168; lon += step, col++) {
    let row = 0;
    for (let lat = -80; lat < 72; lat += step, row++) {
      const value = 0.5 + 0.5 * Math.sin((lon * Math.PI) / 180 * 2) * Math.cos((lat * Math.PI) / 180 * 3);
      cells.push({
        id: `${col}-${row}`,
        value,
        geometry: {
          // Clockwise ring so d3-geo's spherical geoPath fills the small cell
          // interior, not its complement (the whole sphere minus the cell).
          type: "Polygon",
          coordinates: [[[lon, lat], [lon, lat + step], [lon + step, lat + step], [lon + step, lat], [lon, lat]]],
        },
      });
    }
  }
  return cells;
}

async function setup() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const device = await luma.createDevice({
    adapters: [webgl2Adapter],
    type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false },
  });
  const framebuffer = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"] });
  return { device, framebuffer };
}

describe("featureGroup + GroupRenderer (the example path)", () => {
  it("colors projected geoPath cells distinctly (not all one color)", async () => {
    const { device, framebuffer } = await setup();
    const cells = gridCells(8); // ~45x22 grid of geoPath cells
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: cells.map((c): Feature => ({ type: "Feature", properties: {}, geometry: c.geometry })),
    };
    const projection = fitProjection(geoNaturalEarth1(), fc, W, H);
    const scene = new Scene();
    scene.group(
      "cells",
      featureGroup(cells.map((c) => c.geometry), projection, { id: (_g, i) => cells[i]!.id, lineWidth: 0.25 }),
    );
    // Distinct colors: red ramps with the cell's value.
    for (const c of cells) scene.setFill("cells", c.id, `rgb(${Math.round(c.value * 255)}, 0, 0)`);

    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    // Sample many points across the map; collect the distinct red channel values.
    const reds = new Set<number>();
    for (let y = 40; y < 220; y += 20) {
      for (let x = 40; x < 220; x += 20) {
        const p = device.readPixelsToArrayWebGL(framebuffer, { sourceX: x, sourceY: y, sourceWidth: 1, sourceHeight: 1 });
        if (p[3]! > 0) reds.add(p[0]!);
      }
    }
    // If every cell rendered one color (the d3-geo winding bug), this set is ~1.
    // Correctly-wound cells render their own distinct colors.
    expect(reds.size).toBeGreaterThan(3);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});
