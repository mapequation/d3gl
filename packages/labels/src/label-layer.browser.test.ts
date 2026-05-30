import { describe, it, expect, afterEach } from "vitest";
import { LabelLayer } from "./label-layer.js";

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

function setup() {
  container = document.createElement("div");
  document.body.appendChild(container);
  return new LabelLayer(container, (l) => String(l.text));
}

describe("LabelLayer", () => {
  it("creates a positioned DOM node per visible label", () => {
    const layer = setup();
    layer.update(
      [
        { id: "a", refX: 0, refY: 0, text: "A", width: 20, height: 10 },
        { id: "b", refX: 10, refY: 10, text: "B", width: 20, height: 10 },
      ],
      { k: 1, x: 0, y: 0 },
      { width: 100, height: 100 },
    );
    const nodes = container!.querySelectorAll("[data-label-id]");
    expect(nodes.length).toBe(2);
    const a = container!.querySelector<HTMLElement>('[data-label-id="a"]')!;
    expect(a.textContent).toBe("A");
    expect(a.style.left).toBe("0px");
    expect(a.style.top).toBe("0px");
    layer.destroy();
  });

  it("applies the view transform to reference anchors", () => {
    const layer = setup();
    layer.update(
      [{ id: "a", refX: 10, refY: 10, text: "A", width: 5, height: 5 }],
      { k: 2, x: 30, y: 40 }, // screen = k*ref + (x,y) => (50, 60)
      { width: 100, height: 100 },
    );
    const a = container!.querySelector<HTMLElement>('[data-label-id="a"]')!;
    expect(a.style.left).toBe("50px");
    expect(a.style.top).toBe("60px");
    layer.destroy();
  });

  it("removes nodes for labels no longer present on update", () => {
    const layer = setup();
    const vp = { width: 100, height: 100 };
    layer.update([{ id: "a", refX: 0, refY: 0, text: "A" }], { k: 1, x: 0, y: 0 }, vp);
    layer.update([{ id: "b", refX: 0, refY: 0, text: "B" }], { k: 1, x: 0, y: 0 }, vp);
    expect(container!.querySelector('[data-label-id="a"]')).toBeNull();
    expect(container!.querySelector('[data-label-id="b"]')).not.toBeNull();
    layer.destroy();
  });
});
