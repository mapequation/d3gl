import { describe, it, expect } from "vitest";
import { LabelLayer } from "../label-layer.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  el.style.position = "relative";
  document.body.appendChild(el);
  return el;
}

describe("LabelLayer", () => {
  it("applies a per-label className and cross-fade opacity, clearing opacity when unset", () => {
    const h = host();
    const layer = new LabelLayer(h, (a) => a.text, "my-label");
    layer.update([{ id: 1, refX: 50, refY: 50, text: "A", opacity: 0.4 }], { k: 1, x: 0, y: 0 }, { width: 200, height: 200 });

    const el = h.querySelector<HTMLElement>("[data-label-id='1']")!;
    expect(el).toBeTruthy();
    expect(el.className).toBe("my-label");
    expect(el.style.opacity).toBe("0.4"); // cross-fade opacity applied

    // A subsequent update with no opacity restores full opacity (cleared, not stuck at 0.4).
    layer.update([{ id: 1, refX: 50, refY: 50, text: "A" }], { k: 1, x: 0, y: 0 }, { width: 200, height: 200 });
    expect(el.style.opacity).toBe("");

    layer.destroy();
    expect(h.querySelectorAll("[data-label-id]").length).toBe(0);
    h.remove();
  });
});
