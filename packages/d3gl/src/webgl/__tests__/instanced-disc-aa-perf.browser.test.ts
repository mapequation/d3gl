import { describe, it, expect, vi } from "vitest";
import { WebGLDevice } from "@luma.gl/webgl";
import { InstancedCircles, InstancedPie } from "../instanced.js";
import { GroupRenderer } from "../renderer.js";
import { WebGLBackend } from "../webgl-backend.js";
import { Scene } from "../../core/index.js";
import type { InstancedCirclesData, InstancedPieData } from "../../core/index.js";
import { perfBudget, perfN, perfRealGpu, softwareRenderer } from "../../__tests__/perf-budget.js";

/**
 * Per-frame guard for the antialiased disc edges (#570). Every disc shader (instanced circles, pie wedges,
 * Scene points) computes an edge coverage ramp, and each quad grows by half a device pixel so the ramp's
 * outer half is rasterized. That is GPU work on every frame for every drawn disc: a few ALU ops per
 * fragment, and a disc of radius r device px shades ((r + 0.5) / r)² as many fragments (2.25× at r = 1,
 * 1.27× at r = 4; a sub-pixel disc goes from 0 or 1 fragment to 1-4). The CPU side adds no attribute,
 * buffer or pass: only the backend's push of the target's pixel ratio when it changes, which the last leg
 * counts.
 *
 * The timed legs draw ≈1M discs per frame, every one on screen, through the real trigger (a
 * `WebGLBackend.setTransform` zoom sweep, each frame rendered into the 4× MSAA canvas), and time the GPU
 * with a wall clock synced by a one-pixel `readPixels` (on ANGLE/Metal `finish()` returns at once and the
 * timer query reads 0). The lane's GPU cost depends only on the instances it draws, the same whether they
 * are leaves (LOD off) or ≈1M aggregates (LOD on over a large visible set), so these legs cover both. Under
 * software GL a drawn instance costs ≈10 µs per frame (#557), so the timed legs run only on a hardware GPU
 * (`PERF_REAL_GPU=1`); everywhere else each leg runs at a small N and asserts its counts: no buffer created
 * during the sweep, and no pixel-ratio push on a frame drawn into the same target as the last.
 */
const SCALE_MAX = perfRealGpu ? 2_000_000 : 0;
const N = perfRealGpu ? Math.max(1_000_000, perfN(1_000_000, { max: SCALE_MAX })) : 2_000;
const FRAMES = perfRealGpu ? 12 : 3;
const W = 1024;
const H = 768;

/** N centres on a square grid of spacing 1. Each frame zooms from fitting the grid's width (k = W / √N, so
 *  a disc of radius ρ world units is ≈ ρ px) to 2× that. */
function grid(n: number): Float32Array {
  const cols = Math.ceil(Math.sqrt(n));
  const centers = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    centers[2 * i] = i % cols;
    centers[2 * i + 1] = Math.floor(i / cols);
  }
  return centers;
}

function circles(n: number, radius: number, ring: boolean): InstancedCirclesData {
  const centers = grid(n);
  const radii = new Float32Array(n).fill(radius);
  const colors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) colors.set([(i * 37) & 255, (i * 91) & 255, (i * 53) & 255, 255], i * 4);
  if (!ring) return { centers, radii, colors, count: n };
  const borders = new Float32Array(n).fill(0.3);
  const borderColors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) borderColors.set([20, 20, 20, 255], i * 4);
  return { centers, radii, colors, borders, borderColors, count: n };
}

/** n / 2 pies of two wedges each: n wedge instances. */
function pies(n: number, radius: number): InstancedPieData {
  const nodes = grid(Math.ceil(n / 2));
  const centers = new Float32Array(n * 2);
  const radii = new Float32Array(n).fill(radius);
  const angles = new Float32Array(n * 2);
  const colors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const node = i >> 1;
    centers[2 * i] = nodes[2 * node] ?? 0;
    centers[2 * i + 1] = nodes[2 * node + 1] ?? 0;
    const split = 0.25 + (node % 3) * 0.2;
    angles[2 * i] = i % 2 ? split : 0;
    angles[2 * i + 1] = i % 2 ? 1 : split;
    colors.set([(i * 37) & 255, (i * 91) & 255, (i * 53) & 255, 255], i * 4);
  }
  return { centers, radii, angles, colors, count: n };
}

/** A retained Scene of n points (the GroupRenderer point pass). */
function pointScene(n: number, radius: number): Scene {
  const centers = grid(n);
  const scene = new Scene();
  scene.group("points", (g) => {
    for (let i = 0; i < n; i++) g.point(i, centers[2 * i] ?? 0, centers[2 * i + 1] ?? 0, radius);
  });
  for (let i = 0; i < n; i++) scene.setFill("points", i, "#1f77b4");
  return scene;
}

const pixel = new Uint8Array(4);

/** The GPU time of one frame: the wall clock until a one-pixel `readPixels` returns, which waits for the draw. */
function gpuTime(gl: WebGL2RenderingContext, draw: () => void): number {
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const t0 = performance.now();
  draw();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return performance.now() - t0;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
}

/** A backend on an in-document canvas of W × H CSS px (a detached canvas's drawing buffer shrinks to 1×1). */
async function backendOnPage(): Promise<{ backend: WebGLBackend; gl: WebGL2RenderingContext; done: () => void }> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  document.body.appendChild(canvas);
  const backend = await WebGLBackend.create(canvas, { width: W, height: H });
  const device = backend.gpuDevice;
  if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL device");
  return {
    backend,
    gl: device.gl,
    done: () => {
      backend.destroy();
      canvas.remove();
    },
  };
}

async function sweep(setup: (backend: WebGLBackend) => void): Promise<{ created: number; ms: number }> {
  const { backend, gl, done } = await backendOnPage();
  setup(backend);
  backend.setTransform({ k: 1, x: 0, y: 0 });
  backend.render();

  let created = 0;
  const device = backend.gpuDevice;
  const orig = device.createBuffer.bind(device);
  device.createBuffer = (props) => {
    created++;
    return orig(props);
  };

  const fit = W / Math.ceil(Math.sqrt(N));
  const times: number[] = [];
  for (let f = 0; f < FRAMES + 2; f++) {
    backend.setTransform({ k: fit * (1 + f / (FRAMES + 1)), x: 0, y: 0 });
    const ms = gpuTime(gl, () => backend.render());
    if (f >= 2) times.push(ms); // two warm-up frames
  }
  device.createBuffer = orig;
  done();
  return { created, ms: median(times) };
}

// Each leg's budget is c0 + c1·N (ms, N in millions), from the measurements in the PR for #570 (M1 Max, after
// the change) with headroom for a loaded machine. A budget: never loosened to make a run pass.
const legs: { name: string; ms: [number, number]; setup: (backend: WebGLBackend) => void }[] = [
  { name: "plain discs, 2.5-5 px", ms: [4, 16], setup: (b) => b.setInstancedLayer({ name: "nodes", primitive: "circles", circles: circles(N, 2.5, false) }) },
  { name: "ringed discs, 2.5-5 px", ms: [4, 16], setup: (b) => b.setInstancedLayer({ name: "nodes", primitive: "circles", circles: circles(N, 2.5, true) }) },
  { name: "sub-pixel discs, 0.4-0.8 px", ms: [4, 16], setup: (b) => b.setInstancedLayer({ name: "nodes", primitive: "circles", circles: circles(N, 0.4, false) }) },
  { name: "pie wedges, 2.5-5 px", ms: [4, 24], setup: (b) => b.setInstancedLayer({ name: "pies", primitive: "pie", pie: pies(N, 2.5) }) },
  {
    name: "Scene points, 2.5-5 px",
    ms: [4, 16],
    setup: (b) => {
      const scene = pointScene(N, 2.5);
      b.setLayers([{ name: "points", buffers: scene.buffers("points"), drawables: scene.drawables("points") }]);
    },
  },
];

describe("antialiased disc edges per frame (#570)", () => {
  for (const leg of legs) {
    it(`${leg.name}: a zoom sweep creates no buffer${perfRealGpu ? " and stays in its GPU budget" : ""}`, async () => {
      const { created, ms } = await sweep(leg.setup);
      expect(created).toBe(0);
      if (!perfRealGpu) return;
      expect(softwareRenderer()).toBe(false);
      const budget = perfBudget(leg.ms[0] + leg.ms[1] * (N / 1_000_000));
      console.log(`[#570] ${leg.name}: ${ms.toFixed(2)} ms/frame GPU at N=${N.toLocaleString()} (budget ${budget.toFixed(1)})`);
      expect(ms, `${ms.toFixed(2)} ms/frame at N=${N.toLocaleString()}`).toBeLessThan(budget);
    });
  }
});

describe("the disc renderers' pixel ratio (#570)", () => {
  it("is pushed when the target's ratio changes, never per frame", async () => {
    const { backend, done } = await backendOnPage();
    const scene = new Scene();
    scene.group("points", (g) => g.point(0, 40, 40, 6));
    backend.setLayers([{ name: "points", buffers: scene.buffers("points"), drawables: scene.drawables("points") }]);
    backend.setInstancedLayer({ name: "nodes", primitive: "circles", circles: circles(16, 0.4, true) });
    backend.setInstancedLayer({ name: "pies", primitive: "pie", pie: pies(16, 0.4) });
    backend.render();

    const spies = [GroupRenderer, InstancedCircles, InstancedPie].map((c) => vi.spyOn(c.prototype, "setPixelRatio"));
    const pushes = (): number => spies.reduce((n, s) => n + s.mock.calls.length, 0);
    for (let f = 0; f < 30; f++) {
      backend.setTransform({ k: 1 + f / 10, x: -f, y: -f });
      backend.render();
    }
    expect(pushes()).toBe(0);
    // The globe bakes the layers into a 2048 px wide texture: another ratio, one push per renderer.
    backend.setGlobeMode(true, 2 * W, W);
    backend.render();
    expect(pushes()).toBe(3);
    backend.setGlobeMode(false);
    backend.render(); // back to the screen's ratio
    expect(pushes()).toBe(6);
    backend.render();
    expect(pushes()).toBe(6);

    for (const s of spies) s.mockRestore();
    done();
  });
});
