import { describe, it, expect } from "vitest";
import { Scene } from "../../core/index.js";
import { svgFromLayers, serializeTexts } from "../serialize.js";

describe("serializeTexts (#105 N7b-2)", () => {
  it("emits a screen-space <text> per label with anchor, font, fill and escaped content", () => {
    const svg = serializeTexts([{ x: 10, y: 20, text: "A & B <x>", font: "600 11px sans-serif", color: "#222", align: "middle" }]);
    expect(svg).toContain('<text x="10" y="20"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('dominant-baseline="central"');
    expect(svg).toContain("font:600 11px sans-serif");
    expect(svg).toContain('fill="#222"');
    expect(svg).toContain("A &amp; B &lt;x&gt;"); // XML-escaped
  });

  it("renders a halo as paint-order:stroke behind the fill, and opacity when < 1", () => {
    const svg = serializeTexts([{ x: 0, y: 0, text: "n", halo: { color: "#fff", width: 2 }, opacity: 0.5 }]);
    expect(svg).toContain('paint-order="stroke"');
    expect(svg).toContain('stroke="#fff"');
    expect(svg).toContain('stroke-width="4"'); // width * 2
    expect(svg).toContain('opacity="0.500"');
  });

  it("is empty for no labels", () => {
    expect(serializeTexts([])).toBe("");
  });
});

function layer(name: string, clipTo?: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.drawable("d", (c) => c.rect(0, 0, 10, 10)));
  scene.setFill(name, "d", "rgb(10, 20, 30)");
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), clipTo };
}

function circleLayer(name: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.point("p", 5, 7, 3));
  scene.setFill(name, "p", "rgb(255, 0, 0)");
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name) };
}

describe("svgFromLayers", () => {
  it("emits a transform group, a path per drawable, and a clipPath for clipped layers", () => {
    const land = layer("land");
    const cells = layer("cells", "land");
    const svg = svgFromLayers(200, 100, [land, cells], { k: 2, x: 5, y: 7 });
    expect(svg).toContain('width="200"');
    expect(svg).toContain("translate(5, 7) scale(2)");      // view transform
    expect(svg).toContain("<clipPath"); // clip def for the clipped layer
    expect(svg).toContain('clip-path="url(#');             // applied to cells group
    expect(svg).toContain("rgba(10, 20, 30");              // fill color
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(3); // land + clip use + cells
  });

  it("emits a <circle> element for point drawables", () => {
    const dots = circleLayer("dots");
    const svg = svgFromLayers(100, 100, [dots], { k: 1, x: 0, y: 0 });
    expect(svg).toContain("<circle");
    expect(svg).toContain('cx="5"');
    expect(svg).toContain('cy="7"');
    expect(svg).toContain('r="3"');
    expect(svg).toContain("rgba(255, 0, 0");
  });
});
