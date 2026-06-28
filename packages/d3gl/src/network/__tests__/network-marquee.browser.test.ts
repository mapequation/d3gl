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

/** Dispatch a shift+drag from host-relative (x0,y0) to (x1,y1): the move grows the box past CLICK_SLOP. */
function shiftDrag(h: HTMLElement, x0: number, y0: number, x1: number, y1: number): void {
  const r = h.getBoundingClientRect();
  const ev = (type: string, sx: number, sy: number) =>
    h.dispatchEvent(new PointerEvent(type, { clientX: r.left + sx, clientY: r.top + sy, shiftKey: true, bubbles: true, button: 0, pointerId: 1 }));
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
});
