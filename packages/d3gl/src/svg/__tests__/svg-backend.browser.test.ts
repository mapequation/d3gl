import { describe, it, expect } from "vitest";
import { Scene } from "../../core/index.js";
import { SvgBackend } from "../svg-backend.js";

function layer(name: string, color: string, clipTo?: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.drawable("d", (c) => c.rect(0, 0, 50, 50)));
  scene.setFill(name, "d", color);
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), clipTo };
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
});
