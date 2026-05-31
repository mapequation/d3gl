import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";

describe("Scene vector view", () => {
  it("exposes per-drawable subpaths, colors, lineWidth and flags", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10), { lineWidth: 2 });
      b.drawable("b", (ctx) => {
        ctx.moveTo(0, 0);
        ctx.lineTo(5, 0);
      });
    });
    scene.setFill("g", "a", "rgb(255, 0, 0)");
    scene.setStroke("g", "a", "rgb(0, 0, 255)");
    scene.setFlag("g", "b", 0);

    const ds = scene.drawables("g");
    expect(ds.map((d) => d.id)).toEqual(["a", "b"]);

    const a = ds[0]!;
    expect(a.subpaths.length).toBe(1);
    expect(a.subpaths[0]!.closed).toBe(true);
    expect(a.subpaths[0]!.points.length).toBeGreaterThanOrEqual(8); // rect corners
    expect(a.fill).toEqual([255, 0, 0, 255]);
    expect(a.stroke).toEqual([0, 0, 255, 255]);
    expect(a.lineWidth).toBe(2);
    expect(a.flags).toBe(1);

    const b = ds[1]!;
    expect(b.subpaths[0]!.closed).toBe(false);
    expect(b.flags).toBe(0); // hidden
    expect(b.lineWidth).toBe(0); // default
  });
});
