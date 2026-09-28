import { describe, it, expect, vi } from "vitest";
import { luma } from "@luma.gl/core";
import type { Device, Framebuffer, RenderPass } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { InstancedArrows, InstancedCircles, InstancedHalfArrows, InstancedLines, InstancedPie } from "../instanced.js";
import { clipFromView } from "../index.js";

/**
 * Per-frame guard for the instanced lanes' buffer growth. Under LOD the visible frontier changes size on
 * every frame the layout moves or the view zooms, and a lane rewrites its buffers in place while the
 * count fits them. When the count outgrows them the lane reallocates, and it at least doubles its
 * capacity, so a frontier that grows frame after frame reallocates log2(peak / first) times. An exact fit
 * reallocated every buffer of the lane on each frame that set a new high (the streaming GPU layout's
 * LOD leg saw a frontier grow about fourfold over consecutive repaints). Pinned per primitive:
 *
 * - a frontier growing 3% per frame from FIRST to PEAK allocates in at most ⌈log2(PEAK / FIRST)⌉ of
 *   those frames, and each of those grows at least doubles `capacity`;
 * - shrinking and growing back within the room allocates nothing;
 * - the grown buffers draw the instances past the old capacity (circles and lines, the network lanes).
 */
const W = 64;
const H = 64;
const FIRST = 64;
const PEAK = 4096;

/** Frontier sizes from FIRST to PEAK, 3% more each frame. */
function growth(): number[] {
  const out: number[] = [];
  for (let c = FIRST; c < PEAK; c = Math.ceil(c * 1.03)) out.push(c);
  out.push(PEAK);
  return out;
}

/** Every instance off-screen and transparent, except (with `spot`) the last one: opaque red at the view centre. */
function spotlight(n: number, spot: boolean) {
  const pos = new Float32Array(n * 2).fill(-1000);
  const end = new Float32Array(n * 2).fill(-1000);
  const colors = new Uint8Array(n * 4);
  if (spot && n > 0) {
    pos.set([W / 4, H / 2], (n - 1) * 2);
    end.set([(3 * W) / 4, H / 2], (n - 1) * 2);
    colors.set([255, 0, 0, 255], (n - 1) * 4);
  }
  return { pos, end, colors };
}

interface Lane {
  readonly capacity: number;
  update(device: Device, n: number, spot: boolean): void;
  render(pass: RenderPass): void;
  destroy(): void;
}

/** One lane per instanced primitive, over the spotlight data at `n` instances. */
const LANES: { name: string; build: (device: Device, n: number) => Lane }[] = [
  {
    name: "circles",
    build(device, n) {
      const data = (k: number, spot: boolean) => {
        const { pos, colors } = spotlight(k, spot);
        if (spot && k > 0) pos.set([W / 2, H / 2], (k - 1) * 2);
        return { centers: pos, radii: new Float32Array(k).fill(8), colors, count: k };
      };
      const lane = new InstancedCircles(device, data(n, false), W, H);
      lane.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
      return { get capacity() { return lane.capacity; }, update: (d, k, s) => lane.update(d, data(k, s)), render: (p) => lane.render(p), destroy: () => lane.destroy() };
    },
  },
  {
    name: "pie",
    build(device, n) {
      const data = (k: number, spot: boolean) => {
        const { pos, colors } = spotlight(k, spot);
        const angles = new Float32Array(k * 2);
        for (let i = 0; i < k; i++) angles[i * 2 + 1] = 1;
        return { centers: pos, radii: new Float32Array(k).fill(8), angles, colors, count: k };
      };
      const lane = new InstancedPie(device, data(n, false), W, H);
      return { get capacity() { return lane.capacity; }, update: (d, k, s) => lane.update(d, data(k, s)), render: (p) => lane.render(p), destroy: () => lane.destroy() };
    },
  },
  {
    name: "lines",
    build(device, n) {
      const data = (k: number, spot: boolean) => {
        const { pos, end, colors } = spotlight(k, spot);
        return { sources: pos, targets: end, widths: new Float32Array(k).fill(6), colors, count: k };
      };
      const lane = new InstancedLines(device, data(n, false), W, H);
      lane.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
      return { get capacity() { return lane.capacity; }, update: (d, k, s) => void lane.update(d, data(k, s)), render: (p) => lane.render(p), destroy: () => lane.destroy() };
    },
  },
  {
    name: "arrows",
    build(device, n) {
      const data = (k: number, spot: boolean) => {
        const { pos, end, colors } = spotlight(k, spot);
        return { sources: pos, targets: end, radii: new Float32Array(k), sizes: new Float32Array(k).fill(8), colors, count: k };
      };
      const lane = new InstancedArrows(device, data(n, false), W, H);
      return { get capacity() { return lane.capacity; }, update: (d, k, s) => void lane.update(d, data(k, s)), render: (p) => lane.render(p), destroy: () => lane.destroy() };
    },
  },
  {
    name: "half-arrows",
    build(device, n) {
      const data = (k: number, spot: boolean) => {
        const { pos, end, colors } = spotlight(k, spot);
        return { sources: pos, targets: end, radii: new Float32Array(k * 2), widths: new Float32Array(k * 2).fill(4), bends: new Float32Array(k), colors, count: k };
      };
      const lane = new InstancedHalfArrows(device, data(n, false), W, H);
      return { get capacity() { return lane.capacity; }, update: (d, k, s) => void lane.update(d, data(k, s)), render: (p) => lane.render(p), destroy: () => lane.destroy() };
    },
  },
];

async function setup(): Promise<{ device: Device; framebuffer: Framebuffer }> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const device = await luma.createDevice({ adapters: [webgl2Adapter], type: "webgl", createCanvasContext: { canvas, useDevicePixels: false } });
  const framebuffer = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"] });
  return { device, framebuffer };
}

/** Draw `lane` alone and read the view centre's pixel. */
function centre(device: Device, framebuffer: Framebuffer, lane: Lane): ArrayLike<number> {
  const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
  lane.render(pass);
  pass.end();
  device.submit();
  return device.readPixelsToArrayWebGL(framebuffer, { sourceX: W / 2, sourceY: H / 2, sourceWidth: 1, sourceHeight: 1 });
}

describe("instanced lanes grow by doubling, not per frame", () => {
  for (const { name, build } of LANES) {
    it(`${name}: a growing frontier reallocates log2(peak / first) times; shrink and regrowth allocate nothing`, async () => {
      const { device } = await setup();
      const sizes = growth();
      const lane = build(device, sizes[0] ?? FIRST);
      const created = vi.spyOn(device, "createBuffer");
      const grows: { before: number; after: number }[] = [];
      for (const n of sizes.slice(1)) {
        const before = lane.capacity;
        const calls = created.mock.calls.length;
        lane.update(device, n, false);
        if (created.mock.calls.length > calls) grows.push({ before, after: lane.capacity });
      }
      expect(lane.capacity).toBeGreaterThanOrEqual(PEAK);
      expect(grows.length, `${grows.length} reallocating frames over ${sizes.length - 1} growing frames`).toBeLessThanOrEqual(Math.ceil(Math.log2(PEAK / FIRST)));
      for (const g of grows) expect(g.after, `grew from ${g.before} to ${g.after} instances`).toBeGreaterThanOrEqual(2 * g.before);

      const calls = created.mock.calls.length;
      for (const n of [PEAK / 4, 10, PEAK / 2, PEAK]) lane.update(device, n, false);
      expect(created.mock.calls.length, "a shrink or a regrowth within the room allocated").toBe(calls);
      created.mockRestore();
      lane.destroy();
      device.destroy();
    });
  }

  for (const { name, build } of LANES.filter((l) => l.name === "circles" || l.name === "lines")) {
    it(`${name}: the grown buffers draw the instances past the old capacity`, async () => {
      const { device, framebuffer } = await setup();
      const lane = build(device, FIRST);
      // One past the room: the lane grows, and the last instance (beyond the old buffers) is the red one.
      const n = lane.capacity + 1;
      lane.update(device, n, true);
      expect(lane.capacity).toBeGreaterThan(n - 1);
      const grown = centre(device, framebuffer, lane);
      expect(grown[0], "the instance past the old capacity is not drawn after the grow").toBeGreaterThan(200);
      expect(grown[3]).toBeGreaterThan(200);
      // A sub-update within the grown room draws its last instance too.
      lane.update(device, lane.capacity, true);
      const within = centre(device, framebuffer, lane);
      expect(within[0], "the last instance of a sub-update in the grown room is not drawn").toBeGreaterThan(200);
      lane.destroy();
      device.destroy();
    });
  }
});
