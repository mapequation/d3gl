import { describe, it, expect } from "vitest";
import type { PathContext } from "../core/index.js";
import { plot } from "./plot.js";

function mount() {
  const host = document.createElement("div");
  host.style.width = "200px"; host.style.height = "200px";
  document.body.appendChild(host);
  return host;
}

describe("Plot incremental append", () => {
  it("points().append adds pickable points, keeps existing ones", async () => {
    const host = mount();
    const chart = plot(host, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    const pts = chart.points("p", [{ x: 40, y: 40 }], { x: (d) => d.x, y: (d) => d.y, radius: 5, fill: "rgb(255,0,0)", id: (d) => `p${d.x}` });
    chart.render();
    expect(chart.pick(40, 40)?.id).toBe("p40");

    pts.append({ x: 140, y: 140 });
    chart.render();
    expect(chart.pick(140, 140)?.id).toBe("p140"); // appended
    expect(chart.pick(40, 40)?.id).toBe("p40");     // original kept
    chart.destroy();
  });

  it("layer().append adds pickable drawables", async () => {
    const host = mount();
    const chart = plot(host, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    const boxes = chart.layer("b", [{ x: 20, y: 20 }], {
      draw: (ctx: PathContext, d) => ctx.rect(d.x, d.y, 40, 40),
      fill: "rgb(0,0,255)", id: (d) => `b${d.x}`,
    });
    boxes.append({ x: 120, y: 120 });
    chart.render();
    expect(chart.pick(40, 40)?.id).toBe("b20");
    expect(chart.pick(140, 140)?.id).toBe("b120");
    chart.destroy();
  });
});
