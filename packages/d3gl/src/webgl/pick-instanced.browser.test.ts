import { describe, it, expect } from "vitest";
import { WebGLBackend } from "./webgl-backend.js";
import type { InstancedLayer } from "../core/index.js";

/**
 * GPU-readback link picking (#141): the backend renders the pickable link layers' id-encoded pick pass
 * into an offscreen FBO and resolves a screen pixel to the topmost instance index (`gl_InstanceID`).
 */

/** Two horizontal world-space links (identity transform ⇒ world == screen): link 0 at y=20, link 1 at y=44. */
function twoLinks(pickable: boolean): InstancedLayer {
  return {
    name: "links",
    primitive: "lines",
    pickable,
    lines: {
      sources: new Float32Array([10, 20, 10, 44]),
      targets: new Float32Array([54, 20, 54, 44]),
      widths: new Float32Array([8, 8]),
      colors: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
      count: 2,
    },
  };
}

async function makeBackend(): Promise<WebGLBackend> {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const backend = await WebGLBackend.create(canvas, { width: 64, height: 64 });
  return backend;
}

describe("GPU-readback link picking", () => {
  it("resolves a screen pixel to the topmost link instance id (sync/exact)", async () => {
    const backend = await makeBackend();
    backend.setInstancedLayer(twoLinks(true));
    backend.setTransform({ k: 1, x: 0, y: 0 });
    // Over each link's centreline → its instance index; in the gap between them → background (-1).
    expect(backend.pickInstanced!(32, 20, true)).toBe(0);
    expect(backend.pickInstanced!(32, 44, true)).toBe(1);
    expect(backend.pickInstanced!(32, 32, true)).toBe(-1);
    // Off the link span entirely → background.
    expect(backend.pickInstanced!(2, 20, true)).toBe(-1);
    backend.destroy();
  });

  it("async (hover) readback converges to the correct id within a frame or two, never blocking", async () => {
    const backend = await makeBackend();
    backend.setInstancedLayer(twoLinks(true));
    backend.setTransform({ k: 1, x: 0, y: 0 });
    // The async path returns the *previous* call's result (one PBO frame of lag) and never blocks, so a
    // settled cursor converges once the readback fence signals. Poll and assert it lands on the right id —
    // the meaningful hover guarantee; break as soon as it converges so a healthy run is fast. The interval
    // must exceed the readback latency: the return-previous ping-pong harvests slot N's readback on call
    // N+1, so if a call comes back before that readback finished it abandons it and `last` never advances.
    // On a real GPU readback is sub-ms (the real ~16ms rAF cadence is ample); headless software-GL under
    // full-suite contention can take tens of ms, so poll slowly here.
    async function hoverSettle(x: number, y: number, expected: number): Promise<number> {
      let id = -1;
      for (let i = 0; i < 60; i++) {
        id = backend.pickInstanced!(x, y, false);
        if (id === expected) return id;
        await new Promise((r) => setTimeout(r, 50));
      }
      return id;
    }
    expect(await hoverSettle(32, 20, 0)).toBe(0);
    expect(await hoverSettle(32, 44, 1)).toBe(1);
    expect(await hoverSettle(32, 32, -1)).toBe(-1);
    backend.destroy();
  });

  it("returns undefined when no pickable layer is registered (engine falls through)", async () => {
    const backend = await makeBackend();
    backend.setInstancedLayer(twoLinks(false)); // present but not pickable
    backend.setTransform({ k: 1, x: 0, y: 0 });
    expect(backend.pickInstanced!(32, 20, true)).toBeUndefined();
    backend.destroy();
  });

  it("re-renders the pick FBO after a transform change (dirty flag)", async () => {
    const backend = await makeBackend();
    backend.setInstancedLayer(twoLinks(true));
    backend.setTransform({ k: 1, x: 0, y: 0 });
    expect(backend.pickInstanced!(32, 20, true)).toBe(0);
    // Pan everything down by 24px: link 0 moves from screen y=20 to y=44.
    backend.setTransform({ k: 1, x: 0, y: 24 });
    expect(backend.pickInstanced!(32, 44, true)).toBe(0);
    expect(backend.pickInstanced!(32, 20, true)).toBe(-1);
    backend.destroy();
  });
});
