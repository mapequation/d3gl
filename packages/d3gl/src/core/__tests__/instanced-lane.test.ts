import { describe, it, expect } from "vitest";
import { InstancedLane, type SelectionStrategy } from "../instanced-lane.js";

// A toy strategy over 4 points on a line at world x = 0,10,20,30 (y=0), radius 5 (world units).
const PX = [0, 10, 20, 30];
function lineStrategy(): SelectionStrategy {
  return {
    select(t, w) {
      const keep: number[] = [];
      for (let i = 0; i < PX.length; i++) {
        const sx = PX[i]! * t.k + t.x;
        if (sx >= 0 && sx <= w) keep.push(i);
      }
      return Uint32Array.from(keep);
    },
    pick(x, _y, t, visible) {
      let found = -1;
      for (const i of visible) {
        const sx = PX[i]! * t.k + t.x;
        if (Math.abs(x - sx) <= 5 * t.k) found = i; // last match = topmost
      }
      return found;
    },
  };
}

describe("InstancedLane (#108-A)", () => {
  it("select() drives emit() and retains the visible set for pick()", () => {
    const emitted: Uint32Array[] = [];
    const lane = new InstancedLane(lineStrategy(), (visible) => {
      emitted.push(visible);
      return [{ name: "pts", primitive: "circles", circles: { centers: new Float32Array(0), radii: new Float32Array(0), colors: new Uint8Array(0), count: visible.length }, sizeMode: "world" }];
    });

    const layers = lane.update({ k: 1, x: 0, y: 0 }, 25, 25); // x in [0,25] => points 0,1,2
    expect(Array.from(lane.visible)).toEqual([0, 1, 2]);
    expect(layers[0]!.circles!.count).toBe(3);
    expect(emitted).toHaveLength(1);
  });

  it("pick() resolves against the last selected set (topmost wins), -1 on miss", () => {
    const lane = new InstancedLane(lineStrategy(), () => []);
    lane.update({ k: 1, x: 0, y: 0 }, 100, 100); // visible = 0,1,2,3
    expect(lane.pick(10, 0, { k: 1, x: 0, y: 0 })).toBe(1);
    expect(lane.pick(50, 0, { k: 1, x: 0, y: 0 })).toBe(-1);
  });

  it("pick() returns -1 before any update (empty visible set)", () => {
    const lane = new InstancedLane(lineStrategy(), () => []);
    expect(lane.pick(0, 0, { k: 1, x: 0, y: 0 })).toBe(-1);
  });
});
