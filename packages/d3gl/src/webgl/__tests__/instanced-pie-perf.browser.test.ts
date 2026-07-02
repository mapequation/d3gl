import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import type { Device, Framebuffer } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { InstancedPie } from "../instanced.js";
import { clipFromView } from "../index.js";
import type { InstancedPieData } from "../../core/index.js";

/**
 * Per-frame regression guard for the pie glyph (#171). The pie rides the instanced lane like circles:
 * the wedge instance buffers are built ONCE, and a pan/zoom is a `setTransform` uniform change + one
 * instanced draw — O(wedges) on the GPU, ZERO per-frame CPU work and ZERO per-frame buffer allocation.
 * This drives ~100k wedges through a `setTransform` zoom sweep (the real draw trigger) and asserts:
 *   1. the deterministic signature — no GPU buffer is created (nor recreated) during the sweep, and
 *   2. a generous wall-clock frame budget (catches an order-of-magnitude regression, e.g. a per-frame
 *      buffer rebuild) without being flaky under headless software GL.
 * Also exercises the in-place `update()` path (a re-emit at the same count) — it must sub-upload, not
 * reallocate.
 */
const N = 100_000; // wedge instances

function makePie(n: number): InstancedPieData {
  const centers = new Float32Array(n * 2);
  const radii = new Float32Array(n);
  const angles = new Float32Array(n * 2);
  const colors = new Uint8Array(n * 4);
  const groups = new Float32Array(n);
  const cols = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    centers[2 * i] = (i % cols) * 6;
    centers[2 * i + 1] = Math.floor(i / cols) * 6;
    radii[i] = 3;
    // Two-wedge-ish partition varying by index (deterministic, no RNG).
    const split = 0.25 + (i % 3) * 0.2;
    const half = i % 2;
    angles[2 * i] = half ? split : 0;
    angles[2 * i + 1] = half ? 1 : split;
    colors[4 * i] = (i * 37) & 255;
    colors[4 * i + 1] = (i * 91) & 255;
    colors[4 * i + 2] = (i * 53) & 255;
    colors[4 * i + 3] = 255;
    groups[i] = (i / 2) | 0;
  }
  return { centers, radii, angles, colors, groups, count: n };
}

describe("InstancedPie per-frame cost (#171)", () => {
  it("builds instance buffers once; a setTransform zoom sweep allocates nothing and stays in budget", async () => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    document.body.appendChild(canvas);
    const device: Device = await luma.createDevice({ adapters: [webgl2Adapter], type: "webgl", createCanvasContext: { canvas, useDevicePixels: false } });
    const framebuffer: Framebuffer = device.createFramebuffer({ width: size, height: size, colorAttachments: ["rgba8unorm"] });

    // Count GPU buffer allocations from here on (the deterministic build-once signature).
    let created = 0;
    const orig = device.createBuffer.bind(device);
    (device as unknown as { createBuffer: typeof device.createBuffer }).createBuffer = ((props: Parameters<typeof orig>[0]) => {
      created++;
      return orig(props);
    }) as typeof device.createBuffer;

    const pie = new InstancedPie(device, makePie(N), size, size);
    const builtAllocations = created; // buffers allocated by construction (the one-time build)
    expect(builtAllocations).toBeGreaterThan(0);

    const draw = (): void => {
      const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
      pie.render(pass);
      pass.end();
      device.submit();
    };

    const FRAMES = 40;
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      const k = 1 + f * 0.1; // zoom-in sweep
      pie.setTransform(clipFromView({ k, x: -k * 40, y: -k * 40 }, size, size));
      draw();
    }
    const elapsed = performance.now() - t0;

    // (1) Deterministic signature: NOT ONE buffer created during the sweep (no per-frame rebuild).
    expect(created).toBe(builtAllocations);
    // (2) Frame budget: generous ceiling (a per-frame 100k-instance buffer rebuild would blow past this).
    expect(elapsed / FRAMES).toBeLessThan(50);

    // In-place update() at the SAME count must sub-upload, not reallocate.
    const before = created;
    pie.update(device, makePie(N));
    draw();
    expect(created).toBe(before); // sub-upload path: zero new allocations

    pie.destroy();
    device.destroy();
  });
});
