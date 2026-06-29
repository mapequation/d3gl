import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

/**
 * Interactive node-drag (#140), end-to-end through the gesture. A plain drag starting ON a node moves
 * it (and reheats the layout) instead of panning; grabbing a selected node drags the whole selection;
 * grabbing a collapsed aggregate drags its whole subtree. Driven by real pointer events
 * (`pointerdown` on the host → `pointermove`/`pointerup` on the window, as the drag installs).
 *
 * Held positions are written by the **main thread** every move, so the held set is deterministic right
 * after the move event regardless of backend (the neighbour reheat — force rAF loop / worker stream —
 * is async and not asserted here).
 */

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;left:0;top:0;width:200px;height:200px";
  document.body.appendChild(el);
  return el;
}

/** Dispatch a plain drag from host-relative (x0,y0) to (x1,y1). pointerdown on the host arms the drag;
 *  the move/up bubble to the window listeners. A single move past CLICK_SLOP begins + translates. */
function drag(h: HTMLElement, x0: number, y0: number, x1: number, y1: number, release = true): void {
  const r = h.getBoundingClientRect();
  const ev = (type: string, sx: number, sy: number) =>
    h.dispatchEvent(new PointerEvent(type, { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, button: 0, pointerId: 1 }));
  ev("pointerdown", x0, y0);
  ev("pointermove", x1, y1);
  if (release) ev("pointerup", x1, y1);
}

const xy = (net: ReturnType<typeof network>, i: number): [number, number] => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const p = (net as any).graph.positions as Float32Array;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return [p[i * 2]!, p[i * 2 + 1]!];
};

describe("network node-drag (#140)", () => {
  it("drags a single node to the cursor (positions backend, translate-only)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "positions", positions: new Float32Array([40, 40, 100, 100, 160, 160]) });
    net.setTransform({ k: 1, x: 0, y: 0 }); // world == screen
    net.interactive({ draggable: true, selectable: true });

    drag(h, 40, 40, 90, 70); // grab node 0 at its centre, drag by (+50, +30)
    expect(xy(net, 0)[0]).toBeCloseTo(90, 3);
    expect(xy(net, 0)[1]).toBeCloseTo(70, 3);
    // No sim on the positions backend → the other nodes don't move.
    expect(xy(net, 1)).toEqual([100, 100]);
    expect(xy(net, 2)).toEqual([160, 160]);
    net.destroy();
  });

  it("requires interactive({ draggable }) — without it a node is not draggable", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "positions", positions: new Float32Array([40, 40, 120, 120]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ selectable: true }); // selectable but NOT draggable

    drag(h, 40, 40, 90, 70);
    expect(xy(net, 0)).toEqual([40, 40]); // unmoved — no drag without draggable
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((net as any).pickDraggable(40, 40)).toBeNull();
    /* eslint-enable @typescript-eslint/no-explicit-any */
    net.destroy();
  });

  it("a plain click on a node (no movement) does not move it (lazy past-slop start)", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "positions", positions: new Float32Array([40, 40, 120, 120]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ draggable: true, selectable: true });

    const r = h.getBoundingClientRect();
    const at = (type: string) => h.dispatchEvent(new PointerEvent(type, { clientX: r.left + 40, clientY: r.top + 40, bubbles: true, button: 0, pointerId: 1 }));
    at("pointerdown"); at("pointerup"); // down+up, no move
    expect(xy(net, 0)).toEqual([40, 40]); // not moved (no reheat on a click)
    expect(net.selection().map((s) => s.id)).toEqual([0]); // click still selects
    net.destroy();
  });

  it("dragging a selected node moves the whole selection together", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "positions", positions: new Float32Array([40, 40, 80, 80, 160, 160]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ draggable: true, selectable: { multi: true } });
    net.select("nodes", [0, 1]); // multi-selection

    drag(h, 40, 40, 60, 50, false); // grab node 0 (in the selection) → both 0 and 1 translate by (+20,+10)
    expect(xy(net, 0)).toEqual([60, 50]);
    expect(xy(net, 1)).toEqual([100, 90]); // 80+20, 80+10 — moved with the selection
    expect(xy(net, 2)).toEqual([160, 160]); // unselected node 2 stays put
    net.destroy();
  });

  it("dragging a collapsed aggregate moves its whole subtree (LOD)", async () => {
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
    net.setTransform({ k: 1, x: 0, y: 0 }); // two collapsed aggregates on the frontier
    net.interactive({ draggable: true, selectable: { multi: true } });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tree = (net as any).lodTree;
    const visible = (net as any).instancedLanes.get("network").lane.visible as Uint32Array;
    // Module {1,*} = leaves 0,1 (nearest the left). Grab the aggregate whose leaves are 0,1.
    const aggLeft = [...visible].filter((id) => id >= tree.leafCount).find((id) => tree.cx[id] < 100)!;
    const cx = tree.cx[aggLeft], cy = tree.cy[aggLeft];
    /* eslint-enable @typescript-eslint/no-explicit-any */

    drag(h, cx, cy, cx + 40, cy + 0, false); // drag the aggregate by (+40, 0)
    // Both leaves under it translate by the same +40 in x; the other module's leaves stay.
    expect(xy(net, 0)[0]).toBeCloseTo(110, 3); // 70 + 40
    expect(xy(net, 1)[0]).toBeCloseTo(125, 3); // 85 + 40
    expect(xy(net, 2)[0]).toBeCloseTo(115, 3); // unmoved
    expect(xy(net, 3)[0]).toBeCloseTo(130, 3); // unmoved
    net.destroy();
  });

  it("a drag that loops back within click-slop of its start does not also click-select", async () => {
    // Regression: pointerup measures travel from the down point, so a drag that returns near its origin
    // is ≤ CLICK_SLOP — without a guard it would fire a spurious click-select on top of the drag,
    // replacing the multi-selection with just the grabbed node.
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "positions", positions: new Float32Array([40, 40, 80, 80, 160, 160]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ draggable: true, selectable: { multi: true } });
    net.select("nodes", [0, 1]); // multi-selection; grabbing node 0 drags the pair

    const r = h.getBoundingClientRect();
    const ev = (type: string, sx: number, sy: number) =>
      h.dispatchEvent(new PointerEvent(type, { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, button: 0, pointerId: 1 }));
    ev("pointerdown", 40, 40);
    ev("pointermove", 100, 40); // out past slop → drag starts (selection [0,1] preserved + translated)
    ev("pointermove", 40, 40);  // back to the down point → net delta 0
    ev("pointerup", 40, 40);    // within slop of start — must NOT click-select

    expect(net.selection().map((s) => s.id).sort((a, b) => (a as number) - (b as number))).toEqual([0, 1]); // pair intact
    expect(xy(net, 0)).toEqual([40, 40]); // returned to start
    expect(xy(net, 1)).toEqual([80, 80]);
    net.destroy();
  });

  it("with enableZoom, a mouse-drag starting on a node does not pan (d3-zoom mousedown is filtered)", async () => {
    // d3-zoom starts a pan on `mousedown.zoom` (NOT pointerdown), so the node-drag filter must reject
    // mousedown — otherwise pan and node-drag fire together and fight. Driven via real MouseEvents so the
    // d3-zoom filter actually runs (node-drag itself is pointer-driven and isn't exercised here).
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "positions", positions: new Float32Array([40, 40, 100, 100, 160, 160]) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.enableZoom([0.2, 8]);
    net.interactive({ draggable: true, selectable: true });

    const r = h.getBoundingClientRect();
    const mouse = (target: EventTarget, type: string, sx: number, sy: number) =>
      target.dispatchEvent(new MouseEvent(type, { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, button: 0, view: window }));
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tx = () => (net as any).transform as { k: number; x: number; y: number };

    // Control: a mouse-drag on EMPTY space pans (proves d3-zoom responds to these synthetic events).
    (net as any).setTransform({ k: 1, x: 0, y: 0 });
    mouse(h, "mousedown", 190, 10); mouse(window, "mousemove", 150, 10); mouse(window, "mouseup", 150, 10);
    expect(tx().x).not.toBe(0); // panned

    // Starting the same drag ON node 0 must NOT pan — the filter declines so node-drag owns the gesture.
    (net as any).setTransform({ k: 1, x: 0, y: 0 });
    mouse(h, "mousedown", 40, 40); mouse(window, "mousemove", 0, 40); mouse(window, "mouseup", 0, 40);
    expect(tx().x).toBe(0);
    expect(tx().y).toBe(0);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    net.destroy();
  });

  it("on the worker backend, holds the node (zero-lag) and pins/unpins the worker", async () => {
    const h = host();
    const net = network(h, { width: 200, height: 200 });
    await net.whenReady();
    const g = buildGraph({ nodeCount: 6, source: [0, 1, 2, 3, 4], target: [1, 2, 3, 4, 5], directed: false });
    net.data(g).style({ nodeRadius: 8 }).layout({ backend: "worker", iterations: 30 });
    await net.whenSettled(); // initial layout converged; the worker stays alive for reheat
    net.setTransform({ k: 1, x: 0, y: 0 });
    net.interactive({ draggable: true, selectable: true });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const handle = (net as any).layoutHandle;
    expect(handle).toBeTruthy(); // worker NOT torn down after convergence (#140 keep-alive)
    let pinned = 0, unpinned = 0;
    const origPin = handle.pin.bind(handle), origUnpin = handle.unpin.bind(handle);
    handle.pin = (...a: unknown[]) => { pinned++; return (origPin as any)(...a); };
    handle.unpin = (...a: unknown[]) => { unpinned++; return (origUnpin as any)(...a); };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const [p0x, p0y] = xy(net, 0);
    drag(h, p0x, p0y, p0x + 30, p0y - 20); // grab node 0 at its converged centre, drag by (+30,-20)
    // Held node tracks the cursor exactly (main-thread write), independent of the worker.
    expect(xy(net, 0)[0]).toBeCloseTo(p0x + 30, 2);
    expect(xy(net, 0)[1]).toBeCloseTo(p0y - 20, 2);
    expect(pinned).toBeGreaterThan(0);   // worker was pinned + reheated
    expect(unpinned).toBe(1);            // and released on pointerup
    net.destroy();
  });
});
