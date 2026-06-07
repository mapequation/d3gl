import { describe, it, expect } from "vitest";
import { Scene } from "../core/scene.js";
import type { RenderDelta, RenderLayer } from "../core/index.js";
import { CanvasBackend } from "./canvas-backend.js";

const layerOf = (scene: Scene, name: string, clipTo?: string): RenderLayer => ({
  name,
  buffers: scene.buffers(name),
  drawables: scene.drawables(name),
  clipTo,
});

describe("CanvasBackend clip on incremental append", () => {
  it("keeps the clip applied across appends (inside painted, outside clipped) — clip-once, draw-many", () => {
    const scene = new Scene();
    scene.group("land", (b) => b.drawable("L", (c) => c.rect(60, 60, 80, 80))); // land square [60..140]²
    scene.setFill("land", "L", "rgb(0,128,0)");
    scene.group("pts", () => {}); // empty points layer (clipped to land)

    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 200;
    const backend = new CanvasBackend(canvas, 200, 200);
    backend.setLayers([layerOf(scene, "land"), { ...layerOf(scene, "pts"), clipTo: "land" }]);
    backend.render(); // paints the green land
    const ctx = canvas.getContext("2d")!;
    const at = (x: number, y: number): Uint8ClampedArray => ctx.getImageData(x, y, 1, 1).data;

    // First append: a red point INSIDE land — establishes the persistent clip.
    scene.group("d1", (b) => b.point("in", 100, 100, 6));
    scene.setFill("d1", "in", "rgb(255,0,0)");
    backend.appendToLayer({ name: "pts", buffers: scene.buffers("d1"), drawables: scene.drawables("d1") } as RenderDelta);

    // Second append: a red point OUTSIDE land — must reuse the clip and be clipped away.
    scene.group("d2", (b) => b.point("out", 175, 175, 6));
    scene.setFill("d2", "out", "rgb(255,0,0)");
    backend.appendToLayer({ name: "pts", buffers: scene.buffers("d2"), drawables: scene.drawables("d2") } as RenderDelta);

    expect(at(100, 100)[0]!).toBeGreaterThan(180); // red point painted inside land
    expect(at(175, 175)[0]!).toBeLessThan(180); // clipped: no red outside land
    expect(at(70, 70)[1]!).toBeGreaterThan(80); // land still green where no point

    // A full redraw (e.g. after zoom) still shows both accumulated + clipped correctly.
    backend.render();
    expect(at(100, 100)[0]!).toBeGreaterThan(180);
    expect(at(175, 175)[0]!).toBeLessThan(180);
    backend.destroy();
  });
});
