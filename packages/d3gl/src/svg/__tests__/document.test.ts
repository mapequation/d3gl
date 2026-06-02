import { describe, it, expect } from "vitest";
import { svgDocument } from "../document.js";

describe("svgDocument", () => {
  it("wraps styled paths into an svg element of the given size", () => {
    const svg = svgDocument(200, 100, [
      { d: "M0,0L10,0Z", fill: "#ff0000" },
      { d: "M0,0L5,5", stroke: "#00ff00", strokeWidth: 2 },
    ]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="100"');
    expect(svg).toContain('viewBox="0 0 200 100"');
    expect(svg).toContain('<path d="M0,0L10,0Z" fill="#ff0000"');
    expect(svg).toContain('stroke="#00ff00"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("defaults fill to none when only a stroke is given", () => {
    const svg = svgDocument(10, 10, [{ d: "M0,0L1,1", stroke: "#000" }]);
    expect(svg).toContain('fill="none"');
  });

  it("escapes nothing unexpected and skips empty paths", () => {
    const svg = svgDocument(10, 10, [{ d: "", fill: "#000" }, { d: "M0,0L1,1", fill: "#111" }]);
    // empty-d path is omitted
    expect(svg).not.toContain('d=""');
    expect(svg).toContain('d="M0,0L1,1"');
  });
});
