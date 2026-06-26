// packages/d3gl/src/map/multiselect.browser.test.ts
import { describe, it, expect } from "vitest";
import { plot } from "./plot.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px"; el.style.height = "200px"; document.body.appendChild(el); return el;
}
// Click helper: pointerdown+up at (x,y) with optional modifiers, within CLICK_SLOP.
function click(host: HTMLElement, x: number, y: number, mods: Partial<PointerEventInit> = {}) {
  const r = host.getBoundingClientRect();
  const o = { clientX: r.left + x, clientY: r.top + y, bubbles: true, ...mods };
  host.dispatchEvent(new PointerEvent("pointerdown", o));
  host.dispatchEvent(new PointerEvent("pointerup", o));
}

describe("multi-select gestures (#79 / N7c-1)", () => {
  async function setup() {
    const h = host();
    const eng = plot(h, { width: 200, height: 200, backend: "svg" }); // Scene path (selection styling)
    await eng.whenReady();
    const data = [{ id: "a", x: 20, y: 20 }, { id: "b", x: 100, y: 100 }, { id: "c", x: 170, y: 40 }];
    eng.points("pts", data, { x: (d) => d.x, y: (d) => d.y, radius: 8, fill: "#39f", id: (d) => d.id, selection: { others: { opacity: 0.3 } } });
    return { h, eng };
  }

  it("plain click selects one (replace); on(\"select\") fires; selection() reflects it", async () => {
    const { h, eng } = await setup();
    const seen: unknown[][] = [];
    eng.on("select", (sel) => seen.push(sel.map((s) => s.id)));
    click(h, 20, 20);              // select a
    expect(eng.selection().map((s) => s.id)).toEqual(["a"]);
    click(h, 100, 100);            // plain click on b ⇒ replace ⇒ just b
    expect(eng.selection().map((s) => s.id)).toEqual(["b"]);
    expect(seen).toEqual([["a"], ["b"]]);
    eng.destroy();
  });

  it("shift/cmd-click accumulates and toggles", async () => {
    const { h, eng } = await setup();
    eng.on("select", () => {});
    click(h, 20, 20);                          // a
    click(h, 100, 100, { shiftKey: true });    // + b
    expect(eng.selection().map((s) => s.id).sort()).toEqual(["a", "b"]);
    click(h, 170, 40, { metaKey: true });      // + c
    expect(eng.selection().map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
    click(h, 100, 100, { shiftKey: true });    // toggle b OFF
    expect(eng.selection().map((s) => s.id).sort()).toEqual(["a", "c"]);
    eng.destroy();
  });

  it("click on empty space clears; on(\"select\") fires empty", async () => {
    const { h, eng } = await setup();
    const seen: number[] = [];
    eng.on("select", (sel) => seen.push(sel.length));
    click(h, 20, 20); click(h, 100, 100, { shiftKey: true });
    click(h, 5, 195);                          // empty ⇒ clear
    expect(eng.selection()).toEqual([]);
    expect(seen[seen.length - 1]).toBe(0);
    eng.destroy();
  });

  it("applies selection styling (others dimmed) via select(); plain click still fires on(\"click\")", async () => {
    const { h, eng } = await setup();
    let clicks = 0; eng.on("click", () => clicks++); eng.on("select", () => {});
    click(h, 20, 20);                          // select a ⇒ b,c get others {opacity:0.3}
    const svg = eng.toSVG();
    // The SVG backend composes opacity into rgba fill (e.g. rgba(51, 153, 255, 0.3...)),
    // so check that at least one circle is rendered at reduced alpha.
    expect(svg).toMatch(/rgba\(\d+,\s*\d+,\s*\d+,\s*0\.\d*3/);  // non-selected dimmed
    expect(clicks).toBe(1);                    // clickCb still fired
    eng.destroy();
  });
});
