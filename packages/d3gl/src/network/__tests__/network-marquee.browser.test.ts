import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

/**
 * Shift+drag marquee selection (#159), end-to-end through the gesture: a box adds every node/aggregate
 * whose centre is inside it to the selection (additive, like shift+click), driven by the real pointer
 * events (`pointerdown`→`pointermove`→`pointerup`), with the overlay + window listeners it installs.
 */

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;left:0;top:0;width:200px;height:200px";
  document.body.appendChild(el);
  return el;
}

/** Dispatch a shift+drag from host-relative (x0,y0) to (x1,y1): the move grows the box past CLICK_SLOP.
 *  With `alt`, holds option/alt for the whole gesture → a **subtract** marquee (#140 feedback). */
function shiftDrag(h: HTMLElement, x0: number, y0: number, x1: number, y1: number, alt = false): void {
  const r = h.getBoundingClientRect();
  const ev = (type: string, sx: number, sy: number) =>
    h.dispatchEvent(new PointerEvent(type, { clientX: r.left + sx, clientY: r.top + sy, shiftKey: true, altKey: alt, bubbles: true, button: 0, pointerId: 1 }));
  ev("pointerdown", x0, y0); // starts the marquee (onPointerDown → startMarquee)
  ev("pointermove", x1, y1); // bubbles to the window move listener → creates the overlay
  ev("pointerup", x1, y1);   // bubbles to the window up listener → finalizes the region select
}

const idsOf = (net: ReturnType<typeof network>) => net.selection().map((h) => h.id as number).sort((a, b) => a - b);

describe("network shift+drag marquee (#159)", () => {
  it("selects the nodes whose centre falls in the box (no-LOD)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    // nodes 0..3 at (10,10) (100,100) (190,190) (50,150)
    const g = buildGraph({ nodeCount: 4, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 100, 100, 190, 190, 50, 150]) });
    net.setTransform({ k: 1, x: 0, y: 0 }); // world == screen
    net.interactive({ selectable: { multi: true } });

    shiftDrag(h, 40, 40, 160, 160); // box (40,40)-(160,160)
    expect(idsOf(net)).toEqual([1, 3]); // (100,100) and (50,150); (10,10) and (190,190) are outside
    net.destroy();
  });

  it("adds to the existing selection (like shift+click)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 100, 100, 190, 190, 50, 150]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ selectable: { multi: true } });

    net.select("nodes", [0]); // pre-existing selection
    shiftDrag(h, 40, 40, 160, 160);
    expect(idsOf(net)).toEqual([0, 1, 3]); // node 0 kept, box added 1 and 3
    net.destroy();
  });

  it("alt+drag subtracts the box's glyphs from the selection (Illustrator-style)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 100, 100, 190, 190, 50, 150]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ selectable: { multi: true } });

    net.select("nodes", [0, 1, 3]); // start with three selected
    shiftDrag(h, 40, 40, 160, 160, true); // alt held → subtract; box covers nodes 1 (100,100) and 3 (50,150)
    expect(idsOf(net)).toEqual([0]); // 1 and 3 removed; 0 (outside the box) kept
    net.destroy();
  });

  it("shows a + / − mode badge at the cursor while dragging (toggles with alt)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 100, 100]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ selectable: { multi: true } });

    const r = h.getBoundingClientRect();
    const ev = (type: string, sx: number, sy: number, alt: boolean) =>
      h.dispatchEvent(new PointerEvent(type, { clientX: r.left + sx, clientY: r.top + sy, shiftKey: true, altKey: alt, bubbles: true, button: 0, pointerId: 1 }));
    const badge = () => document.querySelector(".d3gl-marquee-badge") as HTMLElement | null;

    net.select("nodes", [1]); // node 1 (100,100) selected → a subtract box over it previews red removal
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const removeIds = () => (net as any).removeIds("nodes") as Set<number> | undefined;

    ev("pointerdown", 20, 20, false);
    ev("pointermove", 120, 120, false); // additive (no alt) → "+"; no red removal preview
    expect(badge()?.textContent).toBe("+");
    expect(removeIds()?.size ?? 0).toBe(0);
    ev("pointermove", 130, 130, true);  // alt held mid-drag → "−"; box covers selected node 1 → red ring
    expect(badge()?.textContent).toBe("−");
    expect([...(removeIds() ?? [])]).toEqual([1]);
    ev("pointerup", 130, 130, true);
    expect(badge()?.style.display).toBe("none"); // hidden on release (the overlay pair is reused, #162)
    expect(removeIds()?.size ?? 0).toBe(0);  // preview set cleared
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(net.selection().map((s) => s.id)).toEqual([]); // node 1 subtracted out
    net.destroy();
  });

  it("selects collapsed aggregates under LOD (frontier region query)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], directed: true });
    const modules = [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ];
    net
      .data(g)
      .lod({ modules, expandPx: 20 })
      .layout({ backend: "positions", positions: new Float32Array([70, 90, 85, 90, 115, 110, 130, 110]) });
    net.setTransform({ k: 1, x: 0, y: 0 }); // collapse to two aggregates on the frontier
    net.interactive({ selectable: { multi: true } });

    shiftDrag(h, 0, 0, 200, 200); // whole canvas → both aggregates
    const hits = net.selection();
    expect(hits.length).toBe(2);
    expect(hits.every((hit) => (hit.datum as { aggregate: boolean }).aggregate)).toBe(true);
    net.destroy();
  });

  it("previews the will-be-selected glyphs with the hover ring while dragging, then commits on release", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 100, 100, 190, 190, 50, 150]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ selectable: { multi: true }, hover: { stroke: "#2563eb" } });

    const r = h.getBoundingClientRect();
    const ev = (type: string, sx: number, sy: number) =>
      h.dispatchEvent(new PointerEvent(type, { clientX: r.left + sx, clientY: r.top + sy, shiftKey: true, bubbles: true, button: 0, pointerId: 1 }));
    ev("pointerdown", 40, 40);
    ev("pointermove", 160, 160); // mid-drag: box (40,40)-(160,160) covers nodes 1 and 3
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const hilite = (net as any).laneHilite.get("nodes") as Set<number> | undefined;
    expect(hilite && [...hilite].sort((a, b) => a - b)).toEqual([1, 3]); // previewed (hover ring)…
    expect(net.selection()).toEqual([]); // …but nothing committed until release
    ev("pointerup", 160, 160);
    expect(((net as any).laneHilite.get("nodes") as Set<number> | undefined)?.size ?? 0).toBe(0); // preview cleared
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(idsOf(net)).toEqual([1, 3]); // committed to the selection
    net.destroy();
  });

  it("a shift+click (no drag) is not a marquee — single additive toggle still works", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 100, 100, 190, 190, 50, 150]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ selectable: { multi: true } });

    // down+up at the same point over node 1 (no movement) → click path, not marquee.
    const r = h.getBoundingClientRect();
    const at = (type: string) => h.dispatchEvent(new PointerEvent(type, { clientX: r.left + 100, clientY: r.top + 100, shiftKey: true, bubbles: true, button: 0, pointerId: 1 }));
    at("pointerdown"); at("pointerup");
    expect(idsOf(net)).toEqual([1]);
    net.destroy();
  });

  // #162 robustness: an interrupted gesture (ctrl-click context menu) used to orphan the overlay box +
  // mode badge so they accumulated on screen. The overlay is now ONE reused pair, torn down on any abort.
  it("a context menu mid-drag tears the marquee down without orphaning overlay elements (#162)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 100, 100, 190, 190, 50, 150]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ selectable: { multi: true } });

    const r = h.getBoundingClientRect();
    const boxes = () => document.querySelectorAll(".d3gl-marquee").length;
    const badges = () => document.querySelectorAll(".d3gl-marquee-badge").length;
    const box0 = boxes(), badge0 = badges();
    // Three shift-drags, each interrupted mid-gesture by a context menu (the ctrl-click bug path).
    for (let i = 0; i < 3; i++) {
      h.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 40, clientY: r.top + 40, shiftKey: true, bubbles: true, button: 0, pointerId: 1 }));
      h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 160, clientY: r.top + 160, shiftKey: true, bubbles: true, pointerId: 1 })); // box appears
      window.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); // interrupt
    }
    // At most ONE reused box + badge for this engine — not one per interrupted gesture.
    expect(boxes() - box0).toBeLessThanOrEqual(1);
    expect(badges() - badge0).toBeLessThanOrEqual(1);
    expect(idsOf(net)).toEqual([]); // none of the interruptions committed a selection
    // A fresh marquee still works after the interruptions.
    shiftDrag(h, 40, 40, 160, 160);
    expect(idsOf(net)).toEqual([1, 3]); // (100,100) and (50,150)
    net.destroy();
    expect(boxes()).toBe(box0); // destroy removes the reused overlay from the DOM
    expect(badges()).toBe(badge0);
  });

  it("Esc cancels an in-flight marquee — no selection committed (#162)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 4, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 6 }).layout({ backend: "positions", positions: new Float32Array([10, 10, 100, 100, 190, 190, 50, 150]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ selectable: { multi: true } });
    net.select("nodes", [0]); // pre-existing selection to confirm Esc leaves it untouched

    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + 40, clientY: r.top + 40, shiftKey: true, bubbles: true, button: 0, pointerId: 1 }));
    h.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + 160, clientY: r.top + 160, shiftKey: true, bubbles: true, pointerId: 1 })); // box covers nodes 1, 3
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // cancel
    expect((document.querySelector(".d3gl-marquee") as HTMLElement | null)?.style.display).toBe("none"); // overlay hidden
    h.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left + 160, clientY: r.top + 160, shiftKey: true, bubbles: true, button: 0, pointerId: 1 }));
    expect(idsOf(net)).toEqual([0]); // unchanged — Esc cancelled before the box could commit 1 and 3
    net.destroy();
  });
});
