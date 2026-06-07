import { describe, it, expect } from "vitest";
import { Scene } from "../../core/index.js";
import { SvgBackend } from "../svg-backend.js";

function layer(name: string, color: string, clipTo?: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.drawable("d", (c) => c.rect(0, 0, 50, 50)));
  scene.setFill(name, "d", color);
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), clipTo };
}

function pointLayer(name: string, cx: number, cy: number, r: number, color: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.point("p", cx, cy, r));
  scene.setFill(name, "p", color);
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name) };
}

describe("SvgBackend", () => {
  it("renders an <svg> with a group per layer and applies the transform", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const backend = new SvgBackend(el, 100, 100);
    backend.setLayers([layer("a", "rgb(255,0,0)")]);
    backend.setTransform({ k: 3, x: 2, y: 1 });
    backend.render();
    const svg = el.querySelector("svg")!;
    expect(svg).toBeTruthy();
    expect(svg.querySelector("g")!.getAttribute("transform")).toContain("scale(3)");
    expect(svg.querySelectorAll("path").length).toBeGreaterThanOrEqual(1);
    backend.destroy();
  });

  it("setTransform on an all-world scene only re-points the view group (no re-serialize)", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const backend = new SvgBackend(el, 100, 100);
    backend.setLayers([layer("a", "rgb(255,0,0)")]); // world sizeMode
    backend.render();
    const view = el.querySelector("svg")!.querySelector("g")!; // first <g> = the view group
    const before = view.innerHTML;
    backend.setTransform({ k: 5, x: 7, y: 9 });
    expect(view.getAttribute("transform")).toBe("translate(7, 9) scale(5)");
    expect(view.innerHTML).toBe(before); // O(1): content was NOT re-serialized
    backend.destroy();
  });

  it("setTransform with screen-mode content re-serializes (coords bake the transform)", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const backend = new SvgBackend(el, 100, 100);
    const scene = new Scene();
    scene.group("p", (b) => b.point("p", 10, 10, 3));
    scene.setFill("p", "p", "rgb(0,0,255)");
    backend.setLayers([{ name: "p", buffers: scene.buffers("p"), drawables: scene.drawables("p"), sizeMode: "screen" }]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    backend.render();
    const svg = el.querySelector("svg")!;
    expect(svg.querySelector("circle")!.getAttribute("cx")).toBe("10"); // 1*10+0
    backend.setTransform({ k: 2, x: 0, y: 0 });
    expect(svg.querySelector("circle")!.getAttribute("cx")).toBe("20"); // re-serialized: 2*10+0
    backend.destroy();
  });

  it("carries a viewBox so content scales (matches canvas/webgl mapping) when CSS resizes the svg", () => {
    const el = document.createElement("div");
    el.style.width = "400px"; el.style.height = "400px"; // larger than the logical 200x200
    document.body.appendChild(el);
    const backend = new SvgBackend(el, 200, 200);
    backend.setLayers([pointLayer("dots", 100, 100, 5, "rgb(0,255,0)")]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    backend.render();
    const svg = el.querySelector("svg")!;
    // A viewBox is required: without it the inner markup stays pinned at 1 user unit = 1px
    // in the top-left and never scales, so a CSS-resized svg renders shifted/zoomed vs the
    // raster backends (whose buffer scales with the element).
    expect(svg.getAttribute("viewBox")).toBe("0 0 200 200");

    // Emulate a docs theme reset that resizes content svgs, then verify the world point
    // (100,100) lands at the uniformly-scaled displayed pixel (200,200) — i.e. the same
    // on-screen mapping a scaled 200x200 canvas would produce.
    svg.style.width = "400px"; svg.style.height = "auto"; svg.style.maxWidth = "100%";
    const circle = svg.querySelector("circle")!;
    const hostRect = el.getBoundingClientRect();
    const cRect = circle.getBoundingClientRect();
    const cx = cRect.left + cRect.width / 2 - hostRect.left;
    const cy = cRect.top + cRect.height / 2 - hostRect.top;
    expect(Math.abs(cx - 200)).toBeLessThan(3);
    expect(Math.abs(cy - 200)).toBeLessThan(3);
    backend.destroy();
  });
});
