import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import { measureText, ELLIPSIS } from "../../labels/index.js";

// #496: `labels({ maxWidth })` draws a long label trimmed with an ellipsis, places on the trimmed box,
// and shows the full label while its glyph is hovered. On all three backends: WebGL's overlay is DOM,
// SVG and Canvas draw native text (read back through toSVG()).
const LONG = "{Allentown/Bethlehem/Easton,PA:LehighValleyInternational}_Albany,NY:AlbanyInternational";
const FONT = "600 11px system-ui, sans-serif";
const MAX = 70;
const NAMES = [LONG, `{Boston,MA:LoganInternational}_Chicago,IL:OHareInternational`, "Ab"];
// Three nodes 80 px apart: full labels (~400 px) collide, 70 px trimmed ones do not.
const POS = new Float32Array([30, 100, 110, 100, 190, 100]);
const graph = () => buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
const BACKENDS = ["webgl", "canvas", "svg"] as const;

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "220px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

async function setup(backend: (typeof BACKENDS)[number], opts: { maxWidth?: number }) {
  const h = host();
  const net = network(h, { width: 220, height: 200, backend });
  await net.whenReady();
  net.data(graph()).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: POS });
  net.interactive({ hover: true });
  net.labels({ labelOf: (id) => NAMES[id], ...opts });
  net.setTransform({ k: 1, x: 0, y: 0 });
  /** The label texts drawn right now (live overlay on WebGL, native text on SVG/Canvas). */
  const texts = (): string[] => {
    if (backend === "webgl") return [...h.querySelectorAll("[data-label-id]")].map((e) => e.textContent ?? "");
    return [...net.toSVG().matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
  };
  const hoverAt = (x: number, y: number) => {
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
  };
  return { net, h, texts, hoverAt };
}

describe.each(BACKENDS)("network.labels({ maxWidth }) (#496) — %s", (backend) => {
  it("default (unset): labels are drawn in full, as before", async () => {
    const { net, h, texts } = await setup(backend, {});
    // Full-width boxes collide, so placement keeps one: it is drawn whole.
    expect(texts().some((t) => NAMES.includes(t) && t.length > 40)).toBe(true);
    expect(texts().some((t) => t.includes(ELLIPSIS))).toBe(false);
    net.destroy(); h.remove();
  });

  it("trims a long label with an ellipsis within maxWidth; a short one is left alone", async () => {
    const { net, h, texts } = await setup(backend, { maxWidth: MAX });
    const shown = texts();
    expect(shown).toContain("Ab");
    const trimmed = shown.filter((t) => t.endsWith(ELLIPSIS));
    expect(trimmed.length).toBe(2);
    for (const t of trimmed) {
      expect(measureText(t, FONT).width).toBeLessThanOrEqual(MAX);
      expect(NAMES.some((n) => n.startsWith(t.slice(0, -1)))).toBe(true);
    }
    expect(shown).not.toContain(LONG);
    net.destroy(); h.remove();
  });

  it("placement uses the trimmed box: labels that collide in full all fit trimmed", async () => {
    const full = await setup(backend, {});
    const nFull = full.texts().length;
    full.net.destroy(); full.h.remove();
    const cut = await setup(backend, { maxWidth: MAX });
    expect(nFull).toBeLessThan(3); // the full-width boxes overlap: placement drops one
    expect(cut.texts().length).toBe(3); // the trimmed boxes do not
    cut.net.destroy(); cut.h.remove();
  });

  it("hovering a node shows its label in full; leaving restores the trimmed one", async () => {
    const { net, h, texts, hoverAt } = await setup(backend, { maxWidth: MAX });
    hoverAt(30, 100); // node 0
    expect(texts()).toContain(LONG);
    expect(texts().filter((t) => t.endsWith(ELLIPSIS)).length).toBe(1); // node 1's, still trimmed
    hoverAt(110, 100); // node 1
    expect(texts()).toContain(NAMES[1]);
    expect(texts()).not.toContain(LONG); // node 0 is back to its trimmed text
    expect(texts().length).toBe(3); // one label per node, none duplicated
    hoverAt(110, 20); // empty space
    expect(texts()).not.toContain(NAMES[1]);
    expect(texts().filter((t) => t.endsWith(ELLIPSIS)).length).toBe(2);
    net.destroy(); h.remove();
  });

  it("the full label survives a re-placement while hovered (pan)", async () => {
    const { net, h, texts, hoverAt } = await setup(backend, { maxWidth: MAX });
    hoverAt(30, 100);
    net.setTransform({ k: 1, x: 5, y: 0 }); // programmatic view change re-places labels
    expect(texts()).toContain(LONG);
    net.destroy(); h.remove();
  });

  it("interactive(false) while hovered puts the trimmed label back", async () => {
    const { net, h, texts, hoverAt } = await setup(backend, { maxWidth: MAX });
    hoverAt(30, 100);
    expect(texts()).toContain(LONG);
    net.interactive(false);
    expect(texts()).not.toContain(LONG);
    expect(texts().filter((t) => t.endsWith(ELLIPSIS)).length).toBe(2);
    net.destroy(); h.remove();
  });

  it("without maxWidth, hover changes nothing about the labels", async () => {
    const { net, h, texts, hoverAt } = await setup(backend, {});
    const before = texts();
    hoverAt(30, 100);
    expect(texts()).toEqual(before);
    net.destroy(); h.remove();
  });
});

describe("network.labels({ maxWidth }) (#496) — hovered label that placement dropped (WebGL)", () => {
  it("shows a hovered label even where collision culled it, then removes it", async () => {
    const h = host();
    const net = network(h, { width: 220, height: 200 });
    await net.whenReady();
    // Two nodes 4 px apart: one label is culled by collision.
    net.data(buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false })).style({ nodeRadius: 6 })
      .layout({ backend: "positions", positions: new Float32Array([100, 100, 104, 100]) });
    net.interactive({ hover: true });
    net.labels({ labelOf: (id) => `node-number-${id}`, maxWidth: 200 });
    net.setTransform({ k: 1, x: 0, y: 0 });
    const els = () => [...h.querySelectorAll("[data-label-id]")].map((e) => e.getAttribute("data-label-id"));
    expect(els().length).toBe(1);
    const dropped = els()[0] === "0" ? 1 : 0;
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + (dropped ? 104 : 100), clientY: r.top + 100, bubbles: true }));
    expect(els().length).toBe(2);
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 10, clientY: r.top + 10, bubbles: true }));
    expect(els().length).toBe(1);
    net.destroy(); h.remove();
  });
});
