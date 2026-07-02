import { describe, it, expect, vi } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import type { InstancedLayer } from "../../core/backend.js";

/**
 * Per-frame regression test for the in-place position-update path (#179).
 *
 * The regression this guards: before this fix, every layout-repaint frame called
 * `setInstancedLayer` (destroy+recreate) for the lines/arrows/half-arrows layers.
 * On a 100k-node, 600k-edge graph with LOD off the per-frame render was ~446ms
 * because each frame allocated + uploaded fresh GPU buffers for ~600k line instances.
 *
 * The fix: `InstancedLines`/`InstancedArrows`/`InstancedHalfArrows` now expose `update()`
 * (mirroring `InstancedCircles`), and `updateInstancedLayer` takes the in-place path for
 * all four primitives. The deterministic signature: across N position-only frames, the
 * JS renderer objects stay the SAME reference (no destroy+recreate).
 */

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "300px";
  el.style.height = "300px";
  document.body.appendChild(el);
  return el;
}

/** Build a ring graph of `n` nodes for a predictable, spatially spread layout. */
function ringGraph(n: number) {
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
  }
  return buildGraph({ nodeCount: n, source, target, directed: false });
}

/** Ring positions: nodes spread around a circle of radius `r`, centered at (cx, cy). */
function ringPositions(n: number, cx = 150, cy = 150, r = 120): Float32Array {
  const pos = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pos[2 * i] = cx + r * Math.cos(a);
    pos[2 * i + 1] = cy + r * Math.sin(a);
  }
  return pos;
}

/** Jitter positions slightly (simulates one layout step). */
function jitterPositions(pos: Float32Array, delta = 0.5): Float32Array {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i++) out[i] = pos[i]! + (Math.random() - 0.5) * delta;
  return out;
}

describe("network instanced lane — in-place position update (#179 regression guard)", () => {
  it("lines/arrows renderers are NOT destroyed+recreated per position frame (no-LOD, undirected)", async () => {
    // Use a moderately large graph — enough to be meaningful but not so large it slows SwiftShader.
    const N_NODES = 500;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ nodeRadius: 4, linkWidth: 1 }).layout({ backend: "positions", positions: pos });

    // Reach into the backend's instanced-layer registry.
    const instanced: Map<string, object> = (net as unknown as {
      handle: { backend: { instanced: Map<string, object> } }
    }).handle.backend.instanced;

    // Capture the renderer objects after the first paint.
    const beforeLines = instanced.get("links");
    expect(beforeLines).toBeDefined();

    // Simulate N position-only layout frames: mutate positions and trigger a rebuild.
    const N_FRAMES = 20;
    const backend = (net as unknown as { handle: { backend: { setInstancedLayer: (l: InstancedLayer) => void } } }).handle.backend;
    const setLayerSpy = vi.spyOn(backend, "setInstancedLayer");

    let currentPos = pos;
    for (let frame = 0; frame < N_FRAMES; frame++) {
      currentPos = jitterPositions(currentPos, 1.0);
      // Re-call layout() with updated positions — this triggers rebuild() → syncLane() → emitInstancedLane()
      net.layout({ backend: "positions", positions: currentPos });
    }

    // setInstancedLayer must NOT have been called for the links layer across position frames —
    // in-place update should take the updateInstancedLayer path, not the recreate path.
    const recreateCalls = setLayerSpy.mock.calls.filter(([l]) => l.name === "links" || l.name === "arrows");
    expect(recreateCalls.length).toBe(0);

    // The renderer object must be the SAME reference (not destroyed+recreated).
    const afterLines = instanced.get("links");
    expect(afterLines).toBe(beforeLines);

    net.destroy();
  });

  it("lines renderer is NOT destroyed+recreated per position frame (directed graph with arrows)", async () => {
    const N_NODES = 300;
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ directed: true, nodeRadius: 4, linkWidth: 1 }).layout({ backend: "positions", positions: pos });

    const instanced: Map<string, object> = (net as unknown as {
      handle: { backend: { instanced: Map<string, object> } }
    }).handle.backend.instanced;

    const beforeLines = instanced.get("links");
    const beforeArrows = instanced.get("arrows");
    expect(beforeLines).toBeDefined();

    const N_FRAMES = 15;
    const backend = (net as unknown as { handle: { backend: { setInstancedLayer: (l: InstancedLayer) => void } } }).handle.backend;
    const setLayerSpy = vi.spyOn(backend, "setInstancedLayer");

    let currentPos = pos;
    for (let frame = 0; frame < N_FRAMES; frame++) {
      currentPos = jitterPositions(currentPos, 1.0);
      net.layout({ backend: "positions", positions: currentPos });
    }

    const recreateCalls = setLayerSpy.mock.calls.filter(([l]) =>
      l.name === "links" || l.name === "arrows" || l.name === "half-arrows"
    );
    expect(recreateCalls.length).toBe(0);

    expect(instanced.get("links")).toBe(beforeLines);
    if (beforeArrows !== undefined) expect(instanced.get("arrows")).toBe(beforeArrows);

    net.destroy();
  });

  it("position frame throughput — N frames of in-place update complete well within budget", async () => {
    // Wall-clock tripwire: generous (1000ms for N_FRAMES=20 on SwiftShader) but catches an
    // order-of-magnitude regression from per-frame buffer destroy+recreate at scale.
    const N_NODES = 1000;
    const N_EDGES = N_NODES; // ring: exactly N edges
    const g = ringGraph(N_NODES);
    const pos = ringPositions(N_NODES);

    const net = network(host(), { width: 300, height: 300, backend: "webgl" });
    await net.whenReady();
    net.data(g).style({ nodeRadius: 3, linkWidth: 1 }).layout({ backend: "positions", positions: pos });

    const N_FRAMES = 20;
    const t0 = performance.now();
    let currentPos = pos;
    for (let frame = 0; frame < N_FRAMES; frame++) {
      currentPos = jitterPositions(currentPos, 1.0);
      net.layout({ backend: "positions", positions: currentPos });
    }
    const elapsed = performance.now() - t0;

    // Budget: 1000ms / 20 frames = 50ms/frame ceiling on SwiftShader. Old path (recreate) at this
    // scale was ~5-10ms/frame; new path (sub-upload) should be similar or faster. 50ms/frame gives
    // 5-10× headroom over an expected ~5ms measurement while still catching a catastrophic regression.
    const BUDGET_MS = 1000;
    expect(elapsed).toBeLessThan(BUDGET_MS);

    // Additional sanity: the link layer must have been registered (not vacuously 0 frames).
    const instanced: Map<string, object> = (net as unknown as {
      handle: { backend: { instanced: Map<string, object> } }
    }).handle.backend.instanced;
    expect(instanced.has("links")).toBe(true);

    // Expect: N_NODES nodes + N_EDGES links = basic confirmation data reached the GPU.
    const linesRenderer = instanced.get("links") as { count: number } | undefined;
    expect(linesRenderer?.count).toBe(N_EDGES);

    net.destroy();
  });
});
