import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";
describe("circle drawables", () => {
  it("records points as circle drawables with fill color + point buffer", () => {
    const s = new Scene();
    s.group("g", (b) => {
      b.point("a", 10, 20, 3);
      b.points("b", [[30, 30], [40, 40]], 2);
    });
    s.setFill("g", "a", "rgb(255,0,0)");
    const ds = s.drawables("g");
    expect(ds[0]!.circles).toEqual([{ x: 10, y: 20, r: 3 }]);
    expect(ds[0]!.fill).toEqual([255, 0, 0, 255]);
    expect(ds[1]!.circles.length).toBe(2);
    const buf = s.buffers("g");
    expect(buf.pointCount).toBe(3);             // 1 + 2 circles
    expect(buf.drawableCount).toBe(2);
    // first circle: x,y,r,drawableId
    expect(Array.from(buf.pointCenters.slice(0, 4))).toEqual([10, 20, 3, 0]);
    expect(buf.pointCenters[11]).toBe(1);        // 3rd circle's drawableId = 1
  });
});
