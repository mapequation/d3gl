import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";

describe("Scene.appendToGroup", () => {
  it("appends drawables to an existing group, continuing ids and ranges", () => {
    const s = new Scene();
    s.group("g", (b) => b.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10)));
    expect(s.drawableCount("g")).toBe(1);

    s.appendToGroup("g", (b) => b.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10)));
    expect(s.drawableCount("g")).toBe(2);

    const r0 = s.range("g", "a");
    const r1 = s.range("g", "b");
    expect(r0.fill.vertexOffset).toBe(0);
    expect(r1.fill.vertexOffset).toBe(4); // continues after "a"
    expect(r1.fill.indexOffset).toBe(6);

    const ds = s.drawables("g");
    expect(ds.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("produces the same buffers as an equivalent single group() build", () => {
    const built = new Scene();
    built.group("g", (b) => {
      b.point("a", 10, 20, 3);
      b.point("b", 30, 40, 2);
    });
    const appended = new Scene();
    appended.group("g", (b) => b.point("a", 10, 20, 3));
    appended.appendToGroup("g", (b) => b.point("b", 30, 40, 2));

    const x = built.buffers("g");
    const y = appended.buffers("g");
    expect(y.pointCount).toBe(x.pointCount);
    expect(y.drawableCount).toBe(x.drawableCount);
    expect(Array.from(y.pointCenters)).toEqual(Array.from(x.pointCenters));
  });

  it("throws on a duplicate drawable id (append and initial build)", () => {
    const s = new Scene();
    s.group("g", (b) => b.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10)));
    expect(() => s.appendToGroup("g", (b) => b.drawable("a", (ctx) => ctx.rect(0, 0, 5, 5)))).toThrow(/duplicate drawable id/);
    expect(() => s.group("h", (b) => { b.point("p", 0, 0, 1); b.point("p", 1, 1, 1); })).toThrow(/duplicate drawable id/);
  });

  it("throws when appending to an unknown group", () => {
    const s = new Scene();
    expect(() => s.appendToGroup("nope", () => {})).toThrow(/unknown group/);
  });
});
