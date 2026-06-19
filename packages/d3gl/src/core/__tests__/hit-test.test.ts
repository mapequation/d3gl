import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";
import { HitIndex } from "../hit-test.js";

const ID = { k: 1, x: 0, y: 0 }; // identity transform: screen == world

describe("HitIndex", () => {
  it("returns the topmost filled drawable under a point, -1 on miss", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("base", (ctx) => ctx.rect(0, 0, 100, 100));
      b.drawable("top", (ctx) => ctx.rect(40, 40, 20, 20)); // overlaps base
    });
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50, ID)).toBe("top");   // overlap -> topmost
    expect(idx.pick(10, 10, ID)).toBe("base");  // base only
    expect(idx.pick(200, 200, ID)).toBe(null);  // miss
  });

  it("skips hidden drawables and hits strokes near the line", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("hidden", (ctx) => ctx.rect(0, 0, 100, 100));
      b.drawable("line", (ctx) => { ctx.moveTo(0, 50); ctx.lineTo(100, 50); }, { lineWidth: 4 });
    });
    scene.setFlag("g", "hidden", 0);
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50, ID)).toBe("line");   // on the line, hidden fill skipped
    expect(idx.pick(50, 70, ID)).toBe(null);     // far from line, fill hidden
  });

  it("hits circle drawables within the radius", () => {
    const scene = new Scene();
    scene.group("g", (b) => b.point("dot", 50, 50, 5));
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(52, 52, ID)).toBe("dot");   // inside r=5
    expect(idx.pick(60, 60, ID)).toBe(null);    // outside
  });

  it("screen-mode picks at the rendered pixel size around the projected anchor (not scaled by zoom)", () => {
    const scene = new Scene();
    scene.group("g", (b) => b.point("dot", 50, 50, 5)); // world (50,50), 5px radius
    const idx = new HitIndex(scene.drawables("g"), 1, /* screenMode */ true);
    const t = { k: 2, x: 0, y: 0 }; // dot renders centered at screen (100,100), radius STAYS 5px

    expect(idx.pick(100, 100, t)).toBe("dot"); // projected center
    expect(idx.pick(104, 100, t)).toBe("dot"); // 4px in — inside the 5px dot
    expect(idx.pick(108, 100, t)).toBe(null);  // 8px in — outside (world mode would accept 10px)
  });

  it("append() makes new drawables pickable without disturbing existing ones", () => {
    const scene = new Scene();
    scene.group("g", (b) => b.point("a", 50, 50, 5));
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50, ID)).toBe("a");

    const before = scene.drawableCount("g");
    scene.appendToGroup("g", (b) => b.point("b", 150, 150, 5));
    idx.append(scene.drawables("g").slice(before)); // index only the newly appended drawables
    expect(idx.pick(150, 150, ID)).toBe("b"); // new one hits
    expect(idx.pick(50, 50, ID)).toBe("a");    // old one still hits
    expect(idx.pick(100, 100, ID)).toBe(null); // gap between them misses
  });
});
