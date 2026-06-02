import { describe, it, expect } from "vitest";
import { plot } from "../plot.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

describe("plot layer lineWidth", () => {
  it("accepts a per-datum function and emits distinct per-drawable stroke widths (svg)", async () => {
    const chart = plot(host(), { width: 200, height: 200, backend: "svg" });
    await chart.whenReady();
    const data = [{ w: 1, y: 10 }, { w: 5, y: 40 }];
    chart.layer("links", data, {
      draw: (ctx, d) => { ctx.moveTo(0, d.y); ctx.lineTo(100, d.y); },
      stroke: "#000000",
      lineWidth: (d) => d.w,
    });
    const svg = chart.toSVG();
    expect(svg).toContain('stroke-width="1"');
    expect(svg).toContain('stroke-width="5"');
    chart.destroy();
  });

  it("still accepts a constant lineWidth", async () => {
    const chart = plot(host(), { width: 200, height: 200, backend: "svg" });
    await chart.whenReady();
    chart.layer("links", [{ y: 10 }, { y: 40 }], {
      draw: (ctx, d) => { ctx.moveTo(0, d.y); ctx.lineTo(100, d.y); },
      stroke: "#000000",
      lineWidth: 2,
    });
    const svg = chart.toSVG();
    expect((svg.match(/stroke-width="2"/g) ?? []).length).toBe(2);
    chart.destroy();
  });
});

describe("plot sizeMode: screen", () => {
  it("non-anchored path: stroke width is constant px (lineWidth ÷ k)", async () => {
    const chart = plot(host(), { width: 200, height: 200, backend: "svg" });
    await chart.whenReady();
    chart.layer("links", [{ y: 10 }], {
      draw: (ctx, d) => { ctx.moveTo(0, d.y); ctx.lineTo(100, d.y); },
      stroke: "#000000", lineWidth: 4, sizeMode: "screen",
    });
    chart.setTransform({ k: 2, x: 0, y: 0 });
    expect(chart.toSVG()).toContain('stroke-width="2"'); // 4 / k=2 → renders 4px under scale(2)
    chart.destroy();
  });

  it("anchored glyph: rendered at a constant size around the projected anchor", async () => {
    const chart = plot(host(), { width: 200, height: 200, backend: "svg" });
    await chart.whenReady();
    chart.layer("glyph", [{}], {
      draw: (ctx) => { ctx.moveTo(95, 95); ctx.lineTo(105, 95); ctx.lineTo(105, 105); ctx.lineTo(95, 105); ctx.closePath(); },
      fill: "#ff0000", anchor: () => [100, 100], sizeMode: "screen",
    });
    chart.setTransform({ k: 3, x: 0, y: 0 });
    const svg = chart.toSVG();
    // Anchor projects to k*100 = 300; vertex offsets (±5) stay ±5 regardless of k → 295..305.
    expect(svg).toContain("295");
    expect(svg).toContain("305");
    chart.destroy();
  });
});
