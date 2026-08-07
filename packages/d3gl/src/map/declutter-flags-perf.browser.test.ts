import { describe, it, expect } from "vitest";
import type { PathContext } from "../core/index.js";
import { Scene } from "../core/index.js";
import { plot } from "./plot.js";
import { WebGLBackend } from "../webgl/index.js";
import { perfBudget, perfN } from "../__tests__/perf-budget.js";

/**
 * Per-frame cost guard for the retained-Scene declutter style push (#208).
 *
 * The regression these pin: on every zoom frame with declutter on, `declutterLayer` used to
 * snapshot the FULL style tables (`styleTables` — fillColors 4N + strokeColors 4N + flags N
 * fresh typed arrays) and WebGL `updateColors` rewrote ALL THREE textures, although declutter
 * only mutates visibility flags. At 1M drawables that was ~9 MB of allocation + ~9 MB of GPU
 * texture upload per zoom frame, ~8/9 redundant. The fix passes the Scene's persistent typed
 * flags view BY REFERENCE (`flagsView`) to `Backend.updateLayerFlags`, which writes only the
 * flags texture (WebGL) or patches the retained vector view in place (Canvas/SVG).
 *
 * Headless WebGL timing is too lenient to catch FPS drops reliably (see
 * plot-points-perf.browser.test.ts), so we assert the regression's deterministic signatures:
 * zero colour-table writes, one flags-only write per frame, and a stable (zero-allocation)
 * flags view reference — plus pixel identity with the full-table path.
 */

function host(w = 480, h = 320): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  document.body.appendChild(el);
  return el;
}

/** Counting wrapper around a GrowTexture-like `{ write(bytes) }` (calls + bytes written). */
function spyWrite(tex: { write(bytes: Uint8Array): void }): { calls: number; bytes: number } {
  const counter = { calls: 0, bytes: 0 };
  const original = tex.write.bind(tex);
  tex.write = (bytes: Uint8Array) => {
    counter.calls++;
    counter.bytes += bytes.length;
    original(bytes);
  };
  return counter;
}

/** The style-table textures of a layer's GroupRenderer (test-only reach into privates). */
interface RendererTextures {
  shape: {
    colorTex: { write(b: Uint8Array): void };
    strokeColorTex: { write(b: Uint8Array): void };
    flagsTex: { write(b: Uint8Array): void };
  };
}

interface EngineInternals {
  handle: { backend: WebGLBackend & { renderers: Map<string, RendererTextures> } };
  scene: Scene;
}

// Zoom OUT over the sweep so the final frame is denser than the start (declutter culls there,
// keeping the end-state assertions non-vacuous) while every frame still moves the flags.
const SWEEP = Array.from({ length: 10 }, (_, k) => ({ k: 1.6 - k * 0.13, x: k * 8, y: k * 5 }));

function makeNodes(n: number, W: number, H: number) {
  // Deterministic grid-ish layout dense enough that declutter culls (and the culled set
  // changes across the zoom sweep — the flags actually move every frame).
  return Array.from({ length: n }, (_, i) => ({ id: i, x: 20 + (i % 60) * ((W - 40) / 60), y: 20 + Math.floor(i / 60) * 9 }));
}

describe("scene declutter flags-only style path (#208)", () => {
  it("webgl: a zoom sweep writes ONLY the flags texture (zero colour copies/uploads), reuses one flags view, and stays pixel-identical to the full push", async () => {
    // The engine-level WebGL trigger — the cell #258 flagged as covered at only N=2000. The tier
    // raises it via PERF_BROWSER_N (#262). Capped at 2M: the style tables are a 256-wide GrowTexture,
    // so beyond ~2.1M rows `createTexture` fails at setLayers — an error, not a budget.
    const W = 480, H = 320, N = perfN(2000, { max: 2_000_000 }), FRAMES = SWEEP.length;
    const chart = plot(host(W, H), { width: W, height: H, backend: "webgl" });
    await chart.whenReady();
    const nodes = makeNodes(N, W, H);
    chart.layer("nodes", nodes, {
      draw: (ctx: PathContext, d) => { ctx.arc(d.x, d.y, 4, 0, 2 * Math.PI); ctx.closePath(); },
      fill: (d) => (d.id % 2 ? "#3b82f6" : "#ef4444"),
      anchor: (d) => [d.x, d.y],
      sizeMode: "screen",
      declutter: 12,
      id: (d) => d.id,
    });
    chart.render();

    const eng = chart as unknown as EngineInternals;
    const backend = eng.handle.backend;
    const renderer = backend.renderers.get("nodes");
    expect(renderer).toBeDefined();
    const fill = spyWrite(renderer!.shape.colorTex);
    const stroke = spyWrite(renderer!.shape.strokeColorTex);
    const flags = spyWrite(renderer!.shape.flagsTex);

    // Spy the backend seam: declutter must go through the flags-only entry point, never the
    // full-table one, and must hand over the SAME Uint8Array every frame (zero per-frame
    // allocation on the engine side).
    let stylesCalls = 0;
    const origStyles = backend.updateLayerStyles.bind(backend);
    backend.updateLayerStyles = (...args: Parameters<WebGLBackend["updateLayerStyles"]>) => {
      stylesCalls++;
      origStyles(...args);
    };
    const flagsRefs = new Set<Uint8Array>();
    let flagsCalls = 0;
    const origFlags = backend.updateLayerFlags.bind(backend);
    backend.updateLayerFlags = (name: string, view: Uint8Array) => {
      flagsCalls++;
      flagsRefs.add(view);
      origFlags(name, view);
    };

    for (const t of SWEEP) chart.setTransform(t);

    console.log(`#208 webgl sweep (N=${N}, frames=${FRAMES}): colour writes=${fill.calls + stroke.calls} (${fill.bytes + stroke.bytes} B), flags writes=${flags.calls} (${flags.bytes} B), updateLayerStyles=${stylesCalls}, updateLayerFlags=${flagsCalls}, distinct views=${flagsRefs.size}`);

    // Deterministic signature: colours untouched, flags-only — N bytes per frame, not 9N.
    expect(fill.calls + stroke.calls).toBe(0);
    expect(flags.calls).toBe(FRAMES);
    expect(flags.bytes).toBe(FRAMES * N);
    expect(stylesCalls).toBe(0);
    expect(flagsCalls).toBe(FRAMES);
    expect(flagsRefs.size).toBe(1); // one persistent view, passed by reference every frame

    // Sanity: declutter actually culls at this density (non-vacuous).
    const view = eng.scene.flagsView("nodes");
    expect(Array.from(view).filter((f) => (f & 1) === 0).length).toBeGreaterThan(0);

    // Pixel identity: the flags-only textures must equal what the full-table push produces.
    const flagsOnlyPNG = chart.toPNG();
    origStyles("nodes", eng.scene.styleTables("nodes"), eng.scene.drawables("nodes"));
    backend.render();
    expect(chart.toPNG()).toBe(flagsOnlyPNG);

    chart.destroy();
  });

  it("webgl: toSVG export reflects flags-only visibility (lazy fold at export time)", async () => {
    // Capped low on purpose: this leg materialises one DOM node per drawable in the export.
    const W = 480, H = 320, N = perfN(1500, { max: 20_000 });
    const chart = plot(host(W, H), { width: W, height: H, backend: "webgl" });
    await chart.whenReady();
    const nodes = makeNodes(N, W, H);
    chart.layer("nodes", nodes, {
      draw: (ctx: PathContext, d) => { ctx.arc(d.x, d.y, 4, 0, 2 * Math.PI); ctx.closePath(); },
      fill: () => "#3b82f6", anchor: (d) => [d.x, d.y], sizeMode: "screen", declutter: 14, id: (d) => d.id,
    });
    chart.render();
    for (const t of SWEEP) chart.setTransform(t);

    const eng = chart as unknown as EngineInternals;
    const visible = Array.from(eng.scene.flagsView("nodes")).filter((f) => (f & 1) === 1).length;
    expect(visible).toBeLessThan(N); // non-vacuous: some culled at the final transform
    const svg = chart.toSVG();
    expect((svg.match(/<path/g) ?? []).length).toBe(visible);
    chart.destroy();
  });

  it("canvas: patches the retained vector view in place — same drawables array, flags in sync with the scene", async () => {
    const W = 480, H = 320, N = perfN(1500, { max: 100_000 });
    const chart = plot(host(W, H), { width: W, height: H, backend: "canvas" });
    await chart.whenReady();
    const nodes = makeNodes(N, W, H);
    chart.layer("nodes", nodes, {
      draw: (ctx: PathContext, d) => { ctx.arc(d.x, d.y, 4, 0, 2 * Math.PI); ctx.closePath(); },
      fill: () => "#3b82f6", anchor: (d) => [d.x, d.y], sizeMode: "screen", declutter: 14, id: (d) => d.id,
    });
    chart.render();

    const eng = chart as unknown as { handle: { backend: { layers: { name: string; drawables: { flags: number }[] }[] } }; scene: Scene };
    const layer = eng.handle.backend.layers.find((l) => l.name === "nodes");
    expect(layer).toBeDefined();
    const before = layer!.drawables;

    for (const t of SWEEP) chart.setTransform(t);

    // Same retained array (no per-frame re-materialization) …
    expect(layer!.drawables).toBe(before);
    // … with every drawable's flag byte patched to the scene's current visibility.
    const view = eng.scene.flagsView("nodes");
    expect(before.every((d, i) => d.flags === view[i])).toBe(true);
    expect(Array.from(view).filter((f) => (f & 1) === 0).length).toBeGreaterThan(0); // non-vacuous
    chart.destroy();
  });

  it("svg: re-serializes exactly the visible drawables after flags-only frames", async () => {
    // One SVG DOM node per visible drawable — the tightest cap in the file.
    const W = 480, H = 320, N = perfN(1500, { max: 20_000 });
    const el = host(W, H);
    const chart = plot(el, { width: W, height: H, backend: "svg" });
    await chart.whenReady();
    const nodes = makeNodes(N, W, H);
    chart.layer("nodes", nodes, {
      draw: (ctx: PathContext, d) => { ctx.arc(d.x, d.y, 4, 0, 2 * Math.PI); ctx.closePath(); },
      fill: () => "#3b82f6", anchor: (d) => [d.x, d.y], sizeMode: "screen", declutter: 14, id: (d) => d.id,
    });
    chart.render();
    for (const t of SWEEP) chart.setTransform(t);

    const eng = chart as unknown as { scene: Scene };
    const visible = Array.from(eng.scene.flagsView("nodes")).filter((f) => (f & 1) === 1).length;
    expect(visible).toBeLessThan(N); // non-vacuous
    expect(el.querySelectorAll("svg path").length).toBe(visible);
    chart.destroy();
  });
});

describe("flags-only declutter frame at 1M drawables (#208 scale guard)", () => {
  it("writes flags in bounded time with zero colour uploads across a simulated declutter sweep", async () => {
    // Full-engine 1M `layer()` glyphs are impractical to build in a headless test (path
    // tessellation dominates), so this drives the exact per-frame seam `declutterLayer` uses —
    // writeDeclutterFlags → flagsView → Backend.updateLayerFlags — at the real 1M scale, on the
    // real backend. The engine-level trigger (setTransform) is covered above at N=2000.
    const N = 1_000_000;
    const scene = new Scene();
    scene.group("pts", (g) => {
      for (let i = 0; i < N; i++) g.point(i, (i % 1000) * 2, ((i / 1000) | 0) * 2, 2);
    });
    const canvas = document.createElement("canvas");
    canvas.width = 480; canvas.height = 320;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 480, height: 320 });
    backend.setLayers([{ name: "pts", buffers: scene.buffers("pts"), drawables: scene.drawables("pts") }]);

    const textures = (backend as unknown as { renderers: Map<string, { point: { colorTex: { write(b: Uint8Array): void }; flagsTex: { write(b: Uint8Array): void } } }> }).renderers.get("pts")!;
    const colour = spyWrite(textures.point.colorTex);
    const flags = spyWrite(textures.point.flagsTex);

    const G = scene.declutterIndex("pts").ax.length; // anchor groups (== N here: unique centers)
    const vis = new Uint8Array(G);
    const FRAMES = 10;
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      for (let g = 0; g < G; g++) vis[g] = (g + f) % 3 ? 1 : 0; // verdict changes every frame
      scene.writeDeclutterFlags("pts", vis);
      backend.updateLayerFlags("pts", scene.flagsView("pts"));
    }
    const perFrame = (performance.now() - t0) / FRAMES;
    console.log(`#208 1M flags-only frame: ${perFrame.toFixed(2)} ms (flags ${flags.bytes / FRAMES} B/frame, colour writes ${colour.calls})`);

    expect(colour.calls).toBe(0); // zero colour uploads
    expect(flags.calls).toBe(FRAMES);
    expect(flags.bytes).toBe(FRAMES * N); // N bytes per frame, not 9N
    // Generous ceiling (headless CI variance) that still catches an order-of-magnitude
    // regression: the old path (9 MB snapshot + 9 MB upload) measured >50 ms/frame CPU alone.
    expect(perFrame).toBeLessThan(perfBudget(40));

    backend.destroy();
    canvas.remove();
  }, perfBudget(120_000));
});
