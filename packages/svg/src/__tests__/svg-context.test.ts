import { describe, it, expect } from "vitest";
import { SvgPathContext } from "../svg-context.js";

describe("SvgPathContext", () => {
  it("builds an SVG path from moveTo/lineTo/closePath", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 0);
    ctx.lineTo(10, 10);
    ctx.closePath();
    expect(ctx.toPath()).toBe("M0,0L10,0L10,10Z");
  });

  it("emits a cubic bezier as a C command", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(0, 10, 10, 10, 10, 0);
    expect(ctx.toPath()).toBe("M0,0C0,10,10,10,10,0");
  });

  it("emits a quadratic bezier as a Q command", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(5, 10, 10, 0);
    expect(ctx.toPath()).toBe("M0,0Q5,10,10,0");
  });

  it("expands rect() into a closed subpath", () => {
    const ctx = new SvgPathContext();
    ctx.rect(1, 2, 10, 20);
    expect(ctx.toPath()).toBe("M1,2L11,2L11,22L1,22Z");
  });

  it("rounds coordinates to 3 decimals", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0.123456, 1.999999);
    expect(ctx.toPath()).toBe("M0.123,2");
  });

  it("beginPath clears the accumulated path", () => {
    const ctx = new SvgPathContext();
    ctx.moveTo(0, 0);
    ctx.lineTo(1, 1);
    ctx.beginPath();
    ctx.moveTo(2, 2);
    expect(ctx.toPath()).toBe("M2,2");
  });

  it("approximates arc() with line segments (flattened)", () => {
    const ctx = new SvgPathContext();
    ctx.arc(0, 0, 10, 0, Math.PI / 2, false);
    const d = ctx.toPath();
    expect(d.startsWith("M10,0")).toBe(true); // arc start point
    expect(d).toContain("L"); // flattened to line segments
  });
});
