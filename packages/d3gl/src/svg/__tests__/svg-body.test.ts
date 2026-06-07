import { describe, it, expect } from "vitest";
import { Scene } from "../../core/scene.js";
import type { RenderLayer } from "../../core/index.js";
import { svgBody, svgFromLayers, viewTransform } from "../serialize.js";

const layerOf = (s: Scene, name: string, sizeMode?: "world" | "screen", clipTo?: string): RenderLayer => ({
  name, buffers: s.buffers(name), drawables: s.drawables(name), sizeMode, clipTo,
});

describe("svgBody (retained-transform split)", () => {
  it("world-mode content is transform-INDEPENDENT — enables the O(1) view-transform path", () => {
    const s = new Scene();
    s.group("land", (b) => b.drawable("L", (c) => c.rect(0, 0, 50, 50), { lineWidth: 1 }));
    s.setFill("land", "L", "rgb(0,128,0)");
    const layers = [layerOf(s, "land")]; // default (world) sizeMode

    const a = svgBody(layers, { k: 1, x: 0, y: 0 });
    const b = svgBody(layers, { k: 3, x: 10, y: 20 });
    expect(a.hasScreen).toBe(false);
    expect(a.world).toBe(b.world); // identical across transforms → group transform alone suffices
    expect(a.screen).toBe("");
    expect(a.world).toContain("<path");
  });

  it("screen-mode bakes the transform into coords (hasScreen, screen content present)", () => {
    const s = new Scene();
    s.group("pts", (b) => b.point("p", 10, 10, 3));
    s.setFill("pts", "p", "rgb(255,0,0)");
    const layers = [layerOf(s, "pts", "screen")];

    const body = svgBody(layers, { k: 2, x: 5, y: 5 });
    expect(body.hasScreen).toBe(true);
    expect(body.screen).toContain("<circle");
    expect(body.screen).toContain('cx="25"'); // k*10 + x = 2*10+5 = 25 (baked)
  });

  it("clipTo emits a clipPath def", () => {
    const s = new Scene();
    s.group("land", (b) => b.drawable("L", (c) => c.rect(0, 0, 50, 50)));
    s.group("pts", (b) => b.drawable("a", (c) => c.rect(5, 5, 5, 5)));
    s.setFill("land", "L", "rgb(0,128,0)");
    s.setFill("pts", "a", "rgb(255,0,0)");
    const body = svgBody([layerOf(s, "land"), { ...layerOf(s, "pts"), clipTo: "land" }], { k: 1, x: 0, y: 0 });
    expect(body.defs).toContain('<clipPath id="clip-pts">');
    expect(body.world).toContain('clip-path="url(#clip-pts)"');
  });

  it("svgFromLayers still composes a <g transform> wrapping the world content", () => {
    const s = new Scene();
    s.group("land", (b) => b.drawable("L", (c) => c.rect(0, 0, 50, 50)));
    s.setFill("land", "L", "rgb(0,128,0)");
    const svg = svgFromLayers(200, 200, [layerOf(s, "land")], { k: 2, x: 3, y: 4 });
    expect(svg).toContain(`<g transform="${viewTransform({ k: 2, x: 3, y: 4 })}">`);
    expect(svg).toContain("<path");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
  });
});
