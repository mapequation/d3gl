import { describe, it, expect } from "vitest";
import type { PathContext } from "../core/index.js";
import { plot, type Plot } from "./plot.js";

/** Read one pixel from the canvas backend's surface (dpr is 1 in the test browser). */
function pixelAt(host: HTMLElement, x: number, y: number): Uint8ClampedArray {
  const canvas = host.querySelector("canvas")!;
  return canvas.getContext("2d")!.getImageData(x, y, 1, 1).data;
}

function pointer(host: HTMLElement, type: string, x: number, y: number): void {
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
}

async function makePlot(): Promise<{ chart: Plot; host: HTMLDivElement }> {
  const host = document.createElement("div");
  host.style.width = "200px"; host.style.height = "200px";
  document.body.appendChild(host);
  const chart = plot(host, { width: 200, height: 200, backend: "canvas" });
  await chart.whenReady();
  return { chart, host };
}

// Two boxes: b0 at (20,20)..(60,60) — probe (40,40); b1 at (120,120)..(160,160) — probe (140,140).
function addBoxes(chart: Plot): void {
  chart.layer<{ x: number; y: number }>("boxes", [{ x: 20, y: 20 }, { x: 120, y: 120 }], {
    draw: (ctx: PathContext, d) => ctx.rect(d.x, d.y, 40, 40),
    fill: (_d, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"),
    id: (_d, i) => `b${i}`,
    hover: { fill: "rgb(0,255,0)" },
  });
  chart.render();
}

describe("Plot interaction options (lifted from BaseEngine, same as GeoMap)", () => {
  it("auto-highlights the hovered drawable, clears on leave", async () => {
    const { chart, host } = await makePlot();
    addBoxes(chart);

    pointer(host, "pointermove", 40, 40);
    expect([...pixelAt(host, 40, 40)].slice(0, 3)).toEqual([0, 255, 0]);
    expect([...pixelAt(host, 140, 140)].slice(0, 3)).toEqual([0, 0, 255]); // b1 untouched

    pointer(host, "pointermove", 140, 140); // cross to b1
    expect([...pixelAt(host, 140, 140)].slice(0, 3)).toEqual([0, 255, 0]);
    expect([...pixelAt(host, 40, 40)].slice(0, 3)).toEqual([255, 0, 0]); // b0 restored

    pointer(host, "pointermove", 90, 90); // gap clears
    expect([...pixelAt(host, 140, 140)].slice(0, 3)).toEqual([0, 0, 255]);
    chart.destroy();
    host.remove();
  });

  it("shows a tooltip on hover and hides it off-target", async () => {
    const { chart, host } = await makePlot();
    chart.layer<{ x: number; y: number }>("boxes", [{ x: 20, y: 20 }], {
      draw: (ctx: PathContext, d) => ctx.rect(d.x, d.y, 40, 40),
      fill: "rgb(0,0,255)", id: () => "b0",
      tooltip: (_d, id) => `box ${id}`,
    });
    chart.render();

    pointer(host, "pointermove", 40, 40);
    const tip = host.querySelector(".d3gl-tooltip") as HTMLDivElement;
    expect(tip).toBeTruthy();
    expect(tip.textContent).toBe("box b0");
    expect(tip.style.display).not.toBe("none");

    pointer(host, "pointermove", 90, 90); // off the layer
    expect(tip.style.display).toBe("none");
    chart.destroy();
    host.remove();
  });

  it("select() dims the complement and clears on null", async () => {
    const { chart, host } = await makePlot();
    chart.layer<{ x: number; y: number }>("boxes", [{ x: 20, y: 20 }, { x: 120, y: 120 }], {
      draw: (ctx: PathContext, d) => ctx.rect(d.x, d.y, 40, 40),
      fill: "rgb(0,0,255)", id: (_d, i) => `b${i}`,
      selection: { others: { opacity: 0.3 } },
    });
    chart.render();

    chart.select("boxes", ["b1"]);
    expect(pixelAt(host, 140, 140)[3]).toBe(255);         // selected: base style
    expect(pixelAt(host, 40, 40)[3]).toBeLessThan(110);   // other: dimmed

    chart.select("boxes", null);
    expect(pixelAt(host, 40, 40)[3]).toBe(255);
    chart.destroy();
    host.remove();
  });

  it("hover works on a point layer too", async () => {
    const { chart, host } = await makePlot();
    chart.points<{ x: number; y: number }>("pts", [{ x: 100, y: 100 }], {
      x: (d) => d.x, y: (d) => d.y, radius: 12,
      fill: "rgb(0,0,255)", id: () => "p0",
      hover: { fill: "rgb(0,255,0)" },
    });
    chart.render();
    pointer(host, "pointermove", 100, 100);
    expect([...pixelAt(host, 100, 100)].slice(0, 3)).toEqual([0, 255, 0]);
    chart.destroy();
    host.remove();
  });

  it("rejects hover/tooltip/selection on passThrough point layers", async () => {
    const { chart, host } = await makePlot();
    expect(() =>
      chart.points("pts", [{ x: 1, y: 1 }], { x: (d: any) => d.x, y: (d: any) => d.y, passThrough: true, hover: true }),
    ).toThrow(/passThrough/);
    chart.destroy();
    host.remove();
  });
});
