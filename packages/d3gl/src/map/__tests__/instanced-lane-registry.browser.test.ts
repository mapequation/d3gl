import { describe, it, expect } from "vitest";
import { plot } from "../plot.js";
import { InstancedLane, type SelectionStrategy } from "../../core/instanced-lane.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px"; el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

// A fake lane over 3 points at world x=0,50,150 (y=0), radius 10; select = those with screen x in [0,w].
const PX = [0, 50, 150];
function fakeStrategy(): SelectionStrategy {
  return {
    select: (t, w) => Uint32Array.from(PX.map((x, i) => [x, i] as const).filter(([x]) => x * t.k + t.x >= 0 && x * t.k + t.x <= w).map(([, i]) => i)),
    pick: (x, _y, t, visible) => { let f = -1; for (const i of visible) if (Math.abs(x - (PX[i]! * t.k + t.x)) <= 10 * t.k) f = i; return f; },
  };
}

describe("BaseEngine instanced-lane registry (#108-B)", () => {
  it("drives a dynamic lane's emit on setTransform and resolves it via pick", async () => {
    const eng = plot(host(), { width: 200, height: 200 }); // webgl by default
    await eng.whenReady();
    let emitCount = 0;
    const lane = new InstancedLane(fakeStrategy(), (visible) => { emitCount++; return [{ name: "fake", primitive: "circles", circles: { centers: new Float32Array(0), radii: new Float32Array(0), colors: new Uint8Array(0), count: visible.length }, sizeMode: "world" }]; });
    // expose the protected registry through a tiny test subclass-free path: cast to any to call the protected API.
    (eng as unknown as { registerInstancedLane: Function }).registerInstancedLane("fake", {
      lane, layerNames: ["fake"], dynamic: true,
      resolve: (i: number) => ({ layer: "fake", id: i, datum: { i } }),
    });
    const emitsAfterRegister = emitCount; // emitted once at register

    eng.setTransform({ k: 1, x: 0, y: 0 });
    expect(emitCount).toBeGreaterThan(emitsAfterRegister); // dynamic ⇒ re-emitted on transform
    // at k=1,x=0,w=200 → all of 0,50,150 are <=200, so visible = [0,1,2]
    expect(Array.from(lane.visible)).toEqual([0, 1, 2]);

    expect(eng.pick(50, 0)).toMatchObject({ layer: "fake", id: 1, datum: { i: 1 } });
    expect(eng.pick(100, 0)).toBeNull(); // between points (dist 50 > radius 10)
    eng.destroy();
  });

  it("emits a static lane once (not on every setTransform) and still resolves pick", async () => {
    const eng = plot(host(), { width: 200, height: 200 });
    await eng.whenReady();
    let emitCount = 0;
    const lane = new InstancedLane(fakeStrategy(), (visible) => { emitCount++; return [{ name: "fake", primitive: "circles", circles: { centers: new Float32Array(0), radii: new Float32Array(0), colors: new Uint8Array(0), count: visible.length }, sizeMode: "world" }]; });
    (eng as unknown as { registerInstancedLane: Function }).registerInstancedLane("fake", {
      lane, layerNames: ["fake"], dynamic: false,
      resolve: (i: number) => ({ layer: "fake", id: i, datum: null }),
    });
    const after = emitCount;
    eng.setTransform({ k: 2, x: -10, y: 0 });
    expect(emitCount).toBe(after); // static ⇒ NOT re-emitted (matrix handles the zoom)
    expect(eng.pick(0 * 2 - 10, 0)).toMatchObject({ id: 0 }); // still pickable; pick uses live transform
    eng.destroy();
  });

  it("unregister stops driving the lane and removes its pick", async () => {
    const eng = plot(host(), { width: 200, height: 200 });
    await eng.whenReady();
    const lane = new InstancedLane(fakeStrategy(), (v) => [{ name: "fake", primitive: "circles", circles: { centers: new Float32Array(0), radii: new Float32Array(0), colors: new Uint8Array(0), count: v.length }, sizeMode: "world" }]);
    const api = eng as unknown as { registerInstancedLane: Function; unregisterInstancedLane: Function };
    api.registerInstancedLane("fake", { lane, layerNames: ["fake"], dynamic: true, resolve: (i: number) => ({ layer: "fake", id: i, datum: null }) });
    eng.setTransform({ k: 1, x: 0, y: 0 });
    expect(eng.pick(50, 0)).toMatchObject({ id: 1 });
    api.unregisterInstancedLane("fake");
    expect(eng.pick(50, 0)).toBeNull(); // lane gone ⇒ no instanced hit
    eng.destroy();
  });
});
