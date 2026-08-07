import { describe, it, expect } from "vitest";
import { plot } from "./plot.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

function count(svg: string, tag: string): number {
  return (svg.match(new RegExp(`<${tag}[\\s/>]`, "g")) ?? []).length;
}

// A decluttered plot points layer renders through the same GPU instanced lane the network uses, so
// it hit the same #200 gap: nothing retained in the Scene ⇒ nothing in the WebGL toSVG(). The
// export-only vector stash is registered per lane in BaseEngine, so this is covered by the same fix.
describe("plot decluttered points: WebGL toSVG() (#200)", () => {
  const data = Array.from({ length: 12 }, (_, i) => ({ x: 10 + i * 15, y: 100 }));

  it("exports the kept (decluttered) glyphs, matching the visible set", async () => {
    const chart = plot(host(), { width: 200, height: 200 }); // webgl default
    await chart.whenReady();
    chart.points("pts", data, { x: (d) => d.x, y: (d) => d.y, radius: 4, fill: "#e4572e", declutter: 40 });
    chart.setTransform({ k: 1, x: 0, y: 0 });

    const svg = chart.toSVG();
    const kept = count(svg, "circle");
    expect(kept).toBeGreaterThan(0); // the lane's glyphs reach the export
    expect(kept).toBeLessThan(data.length); // …and only the kept ones (40px exclusion, 15px pitch)
    expect(svg).toContain("rgba(228, 87, 46"); // the layer fill reached the export
    chart.destroy();
  });

  it("a non-decluttered layer (Scene path) is unaffected", async () => {
    const chart = plot(host(), { width: 200, height: 200 }); // webgl default
    await chart.whenReady();
    chart.points("pts", data, { x: (d) => d.x, y: (d) => d.y, radius: 4, fill: "#e4572e" });
    chart.setTransform({ k: 1, x: 0, y: 0 });

    expect(count(chart.toSVG(), "circle")).toBe(data.length);
    chart.destroy();
  });
});
