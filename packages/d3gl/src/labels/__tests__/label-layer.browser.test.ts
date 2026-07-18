import { describe, it, expect } from "vitest";
import { LabelLayer, resolveLabelStyle } from "../label-layer.js";

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

const ANCHOR = { id: 1, refX: 50, refY: 50, text: "A" };
const VIEW = { width: 200, height: 200 };
const el1 = (h: HTMLElement) => h.querySelector<HTMLElement>("[data-label-id='1']")!;

describe("LabelLayer styling (#224)", () => {
  it("applies `style` inline to each element, as given", () => {
    const h = host();
    const layer = new LabelLayer(h, (a) => a.text, undefined, { color: "rgb(31, 41, 55)", textShadow: "0 0 3px #fff" });
    layer.update([ANCHOR], { k: 1, x: 0, y: 0 }, VIEW);

    const el = el1(h);
    expect(el.style.color).toBe("rgb(31, 41, 55)");
    expect(el.style.textShadow).toContain("3px");
    layer.destroy();
    h.remove();
  });

  it("a raw layer without `style` stays unstyled — elements inherit from the container as before", () => {
    const h = host();
    const layer = new LabelLayer(h, (a) => a.text);
    layer.update([ANCHOR], { k: 1, x: 0, y: 0 }, VIEW);

    const el = el1(h);
    expect(el.style.font).toBe("");
    expect(el.style.color).toBe("");
    expect(el.style.textShadow).toBe("");
    layer.destroy();
    h.remove();
  });

  it("the engine policy result lands on elements: defaults merged, className opting out", () => {
    const h = host();
    // net.labels()-style wiring: pass resolveLabelStyle's result through.
    const layer = new LabelLayer(h, (a) => a.text, undefined, resolveLabelStyle(undefined, { color: "rgb(31, 41, 55)" }));
    layer.update([ANCHOR], { k: 1, x: 0, y: 0 }, VIEW);

    const el = el1(h);
    expect(el.style.color).toBe("rgb(31, 41, 55)"); // the override
    expect(el.style.font).toContain("11px"); // the rest of DEFAULT_LABEL_STYLE kept
    expect(el.style.textShadow).toContain("3px"); // the white halo
    layer.destroy();
    h.remove();
  });

  // Per-frame signature (AGENTS §5): style application runs ONCE at element creation, never on the
  // per-transform update path — a reused element is repositioned (left/top) but not restyled.
  it("styles once at creation: the per-transform update repositions but never restyles", () => {
    const h = host();
    const layer = new LabelLayer(h, (a) => a.text, undefined, resolveLabelStyle(undefined, undefined));
    layer.update([ANCHOR], { k: 1, x: 0, y: 0 }, VIEW);

    const el = el1(h);
    const left0 = el.style.left;
    el.style.color = "red"; // sentinel: any per-update restyle would overwrite it
    layer.update([ANCHOR], { k: 1, x: 5, y: 9 }, VIEW); // pan — same element reused
    expect(el1(h)).toBe(el); // reconciler reused the node (no recreate per frame)
    expect(el.style.left).not.toBe(left0); // repositioned…
    expect(el.style.color).toBe("red"); // …but NOT restyled per transform
    layer.destroy();
    h.remove();
  });
});
