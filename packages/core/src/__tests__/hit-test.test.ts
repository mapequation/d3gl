import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";
import { HitIndex } from "../hit-test.js";

describe("HitIndex", () => {
  it("returns the topmost filled drawable under a point, -1 on miss", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("base", (ctx) => ctx.rect(0, 0, 100, 100));
      b.drawable("top", (ctx) => ctx.rect(40, 40, 20, 20)); // overlaps base
    });
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50)).toBe("top");   // overlap -> topmost
    expect(idx.pick(10, 10)).toBe("base");  // base only
    expect(idx.pick(200, 200)).toBe(null);  // miss
  });

  it("skips hidden drawables and hits strokes near the line", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("hidden", (ctx) => ctx.rect(0, 0, 100, 100));
      b.drawable("line", (ctx) => { ctx.moveTo(0, 50); ctx.lineTo(100, 50); }, { lineWidth: 4 });
    });
    scene.setFlag("g", "hidden", 0);
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50)).toBe("line");   // on the line, hidden fill skipped
    expect(idx.pick(50, 70)).toBe(null);     // far from line, fill hidden
  });
});
