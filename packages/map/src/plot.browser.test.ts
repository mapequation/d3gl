import { describe, it, expect } from "vitest";
import type { PathContext } from "@d3gl/core";
import { plot } from "./plot.js";

describe("plot engine", () => {
  it("draws via a context fn, recolors, hit-tests, switches backend", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);
    const chart = plot(host, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    const rects = [{ x: 20, y: 20 }, { x: 120, y: 120 }];
    chart.layer("boxes", rects, {
      draw: (ctx: PathContext, d) => ctx.rect(d.x, d.y, 40, 40),
      fill: (_d, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"),
      id: (_d, i) => `b${i}`,
    });
    chart.render();
    expect(chart.pick(40, 40)?.id).toBe("b0");      // inside first box
    expect(chart.pick(140, 140)?.id).toBe("b1");
    expect(chart.pick(80, 80)).toBe(null);          // gap
    chart.recolor("boxes");
    chart.setBackend("webgl");
    await chart.whenReady();
    expect(host.querySelector("canvas")).toBeTruthy();
    chart.destroy();
  });
});
