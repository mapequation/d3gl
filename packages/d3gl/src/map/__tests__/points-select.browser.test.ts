import { describe, it, expect } from "vitest";
import { plot } from "../plot.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

// N7c-2: a decluttered points layer renders via the instanced lane AND is interactive — selection
// shows a ring overlay, and members() lists the points absorbed under the kept survivor.
describe("plot declutter points — interactive lane (#105 N7c-2)", () => {
  it("selects a kept point and lists its absorbed members()", async () => {
    const chart = plot(host(), { width: 200, height: 200 }); // webgl by default
    await chart.whenReady();
    // points 0 (x=10) and 1 (x=12) collide under declutter:20 (centre dist 2 < 20) → 1 absorbed by 0;
    // point 2 (x=150) stands alone.
    const data = [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 150, y: 150 }];
    chart.points("pts", data, {
      x: (d) => d.x, y: (d) => d.y, radius: 5, fill: "#000",
      declutter: 20, selectable: true, id: (_d, i) => i,
    });

    chart.select("pts", [0]); // exercises the ring overlay emit (must not throw)
    const sel = chart.selection();
    expect(sel.map((h) => h.id)).toEqual([0]);
    expect(sel[0]!.datum).toEqual({ x: 10, y: 10 });
    expect([...(sel[0]!.members?.() ?? [])].sort((a, b) => (a as number) - (b as number))).toEqual([0, 1]);

    chart.select("pts", null);
    expect(chart.selection()).toEqual([]);
    chart.destroy();
  });

  it("pick on the lane resolves a point hit with members()", async () => {
    const chart = plot(host(), { width: 200, height: 200 });
    await chart.whenReady();
    const data = [{ x: 30, y: 30 }, { x: 33, y: 30 }, { x: 160, y: 160 }];
    chart.points("pts", data, {
      x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "#000",
      declutter: 24, selectable: true, hover: true, id: (_d, i) => i,
    });

    const hit = chart.pick(30, 30); // kept survivor at (30,30)
    expect(hit?.layer).toBe("pts");
    expect(hit?.id).toBe(0);
    expect([...(hit?.members?.() ?? [])].sort((a, b) => (a as number) - (b as number))).toEqual([0, 1]);
    chart.destroy();
  });

  it("#162 dims non-selected kept points to selection.others.opacity (default 0.3)", async () => {
    const chart = plot(host(), { width: 200, height: 200 });
    await chart.whenReady();
    // Points 0 (x=10) + 1 (x=12) collide under declutter:20 → 0 keeps, 1 absorbed; point 2 (x=150) stands alone.
    const data = [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 150, y: 150 }];
    chart.points("pts", data, { x: (d) => d.x, y: (d) => d.y, radius: 5, fill: "#000", declutter: 20, selectable: true, id: (_d, i) => i });
    const T = { k: 1, x: 0, y: 0 };
    chart.setTransform(T);

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const lane = (chart as any).instancedLanes.get("points:pts").lane;
    chart.select("pts", [2]); // select the standalone point
    const colors = lane.update(T, 200, 200)[0].circles.colors as Uint8Array;
    const kept = [...(lane.visible as Uint32Array)]; // kept survivor indices, parallel to the colour instances
    const alphaOf = (pt: number): number => colors[kept.indexOf(pt) * 4 + 3]!;
    expect(alphaOf(2)).toBe(255); // selected point 2 stays full
    expect(alphaOf(0)).toBe(Math.round(255 * 0.3)); // non-selected kept survivor 0 is dimmed

    chart.select("pts", null);
    const cleared = lane.update(T, 200, 200)[0].circles.colors as Uint8Array;
    expect(cleared[kept.indexOf(0) * 4 + 3]).toBe(255); // dim removed on clear
    /* eslint-enable @typescript-eslint/no-explicit-any */
    chart.destroy();
  });
});
