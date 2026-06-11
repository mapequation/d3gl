import { describe, it, expect } from "vitest";
import { Scene } from "../../core/index.js";
import { HighlightBuilder, resolveHighlight, type PendingColor } from "../highlight.js";

function sourceScene(): Scene {
  const scene = new Scene();
  scene.group("src", (g) => {
    g.drawable("sq", (ctx) => ctx.rect(0, 0, 10, 10));
    g.point("pt", 30, 30, 4);
  });
  scene.setFill("src", "sq", "rgb(10,20,30)");
  return scene;
}

describe("HighlightBuilder", () => {
  it("replay copies the source geometry with style overrides; base fill is kept by default", () => {
    const scene = sourceScene();
    const colors: PendingColor[] = [];
    scene.group("hl", (g) => {
      const b = new HighlightBuilder(g, scene.drawableOf("src", "sq")!, colors);
      b.replay({ stroke: "#fff", lineWidth: 2 });
    });
    expect(scene.drawableCount("hl")).toBe(1);
    const d = scene.drawables("hl")[0]!;
    expect(d.subpaths.length).toBeGreaterThan(0);
    expect(d.lineWidth).toBe(2);
    expect(colors[0]!.fill).toBe("rgba(10,20,30,1)"); // kept base fill
    expect(colors[0]!.stroke).toBe("#fff");
  });

  it("replay scales circle drawables; anchor exposes the point center", () => {
    const scene = sourceScene();
    const colors: PendingColor[] = [];
    scene.group("hl", (g) => {
      const b = new HighlightBuilder(g, scene.drawableOf("src", "pt")!, colors);
      expect(b.anchor).toEqual([30, 30]);
      b.replay({ fill: "#fff", radiusScale: 1.5 });
    });
    expect(scene.drawables("hl")[0]!.circles[0]!.r).toBe(6);
  });

  it("path/point record arbitrary geometry; defaultHighlight outlines paths and rings circles", () => {
    const scene = sourceScene();
    const colors: PendingColor[] = [];
    scene.group("hl", (g) => {
      const sq = new HighlightBuilder(g, scene.drawableOf("src", "sq")!, colors);
      sq.path((ctx) => { ctx.arc(5, 5, 8, 0, 2 * Math.PI); ctx.closePath(); }, { stroke: "#f00", lineWidth: 1 });
      sq.point(5, 5, 2);
      sq.defaultHighlight();
      const pt = new HighlightBuilder(g, scene.drawableOf("src", "pt")!, colors);
      pt.defaultHighlight(); // ring just outside the dot
    });
    expect(scene.drawableCount("hl")).toBe(4);
    expect(colors.some((c) => c.stroke === "#fff")).toBe(true);
  });

  it("resolveHighlight maps option forms to draw fns", () => {
    const fn = (): void => {};
    expect(resolveHighlight(fn as any)).toBe(fn);
    expect(typeof resolveHighlight({ stroke: "#fff" })).toBe("function");
    expect(typeof resolveHighlight(true)).toBe("function");
    expect(typeof resolveHighlight(undefined)).toBe("function");
  });
});
