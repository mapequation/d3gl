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
