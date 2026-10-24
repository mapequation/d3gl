import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import type { Device, Framebuffer } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { InstancedCircles, InstancedLines, radiusColumnStats } from "../instanced.js";
import { IndexedLines } from "../indexed-links.js";
import { arrowHead } from "../../core/arrowhead.js";
import type { ArrowParams } from "../../core/arrowhead.js";
import type { InstancedArrowsData } from "../../core/index.js";
import { clipFromView } from "../index.js";
import { WebGLBackend } from "../webgl-backend.js";

const W = 64;
const H = 64;

async function setup() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const device = await luma.createDevice({
    adapters: [webgl2Adapter],
    type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false },
  });
  const framebuffer = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"] });
  return { device, framebuffer };
}

function px(device: Device, framebuffer: Framebuffer, x: number, y: number) {
  return device.readPixelsToArrayWebGL(framebuffer, { sourceX: x, sourceY: y, sourceWidth: 1, sourceHeight: 1 });
}

describe("InstancedCircles", () => {
  it("draws a circle at its world centre in its colour, transparent outside the disc", async () => {
    const { device, framebuffer } = await setup();
    const circles = new InstancedCircles(
      device,
      { centers: new Float32Array([32, 32]), radii: new Float32Array([12]), colors: new Uint8Array([255, 0, 0, 255]), count: 1 },
      W,
      H,
    );
    circles.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    circles.render(pass);
    pass.end();
    device.submit();

    const centre = px(device, framebuffer, 32, 32);
    const outside = px(device, framebuffer, 2, 2);
    expect(centre[0]).toBeGreaterThan(200); // red present at the centre
    expect(centre[3]!).toBeGreaterThan(200); // opaque
    expect(outside[3]).toBe(0); // transparent outside the disc

    circles.destroy();
    device.destroy();
  });

  it("draws multiple instances at distinct centres/colours", async () => {
    const { device, framebuffer } = await setup();
    // two circles on the same row (y=32, the framebuffer centre row → no y-flip ambiguity)
    const circles = new InstancedCircles(
      device,
      {
        centers: new Float32Array([16, 32, 48, 32]),
        radii: new Float32Array([8, 8]),
        colors: new Uint8Array([0, 255, 0, 255, 0, 0, 255, 255]),
        count: 2,
      },
      W,
      H,
    );
    circles.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    circles.render(pass);
    pass.end();
    device.submit();

    const green = px(device, framebuffer, 16, 32);
    const blue = px(device, framebuffer, 48, 32);
    expect(green[1]).toBeGreaterThan(200);
    expect(blue[2]).toBeGreaterThan(200);

    circles.destroy();
    device.destroy();
  });
});

describe("WebGLBackend instanced layer", () => {
  it("renders an instanced circles layer through the backend (readPixel)", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: W, height: H });

    backend.setInstancedLayer({
      name: "nodes",
      primitive: "circles",
      circles: { centers: new Float32Array([32, 32]), radii: new Float32Array([12]), colors: new Uint8Array([0, 200, 0, 255]), count: 1 },
      sizeMode: "world",
    });
    backend.setTransform({ k: 1, x: 0, y: 0 });

    const centre = backend.readPixel(32, 32);
    const outside = backend.readPixel(2, 2);
    expect(centre[1]).toBeGreaterThan(150); // green node present at the centre
    expect(outside[3]).toBe(0); // transparent elsewhere

    backend.removeInstancedLayer("nodes");
    expect(backend.readPixel(32, 32)[3]).toBe(0); // gone after removal

    backend.destroy();
  });
});

describe("InstancedLines", () => {
  it("draws an instanced straight line at its world endpoints in its colour", async () => {
    const { device, framebuffer } = await setup();
    const lines = new InstancedLines(
      device,
      {
        sources: new Float32Array([10, 32]),
        targets: new Float32Array([54, 32]),
        widths: new Float32Array([6]),
        colors: new Uint8Array([0, 0, 255, 255]),
        count: 1,
      },
      W,
      H,
    );
    lines.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    lines.render(pass);
    pass.end();
    device.submit();

    const onLine = px(device, framebuffer, 32, 32); // midpoint, on the segment
    const offLine = px(device, framebuffer, 32, 10); // away from the segment
    expect(onLine[2]).toBeGreaterThan(200); // blue along the line
    expect(offLine[3]).toBe(0); // transparent away from it

    lines.destroy();
    device.destroy();
  });
});

// #162 — verify the SHADER HIGHLIGHT actually renders (not just that uniforms are set): a hover/selection
// is a uniform change on the existing geometry, dimming non-highlighted instances and tinting links red.
describe("instanced shader highlight (#162)", () => {
  const draw = (device: Device, framebuffer: Framebuffer, r: { render(p: any): void }): void => {
    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
    r.render(pass);
    pass.end();
    device.submit();
  };

  it("dims a non-highlighted circle's alpha via a uniform (no geometry change)", async () => {
    const { device, framebuffer } = await setup();
    // Two opaque green circles; group 0 at (20,32), group 1 at (44,32).
    const circles = new InstancedCircles(
      device,
      { centers: new Float32Array([20, 32, 44, 32]), radii: new Float32Array([10, 10]), colors: new Uint8Array([0, 200, 0, 255, 0, 200, 0, 255]), groups: new Float32Array([0, 1]), count: 2 },
      W,
      H,
    );
    circles.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    circles.setHighlight({ hoverGroup: 0, dimActive: true, dimOpacity: 0.25 }); // hover group 0 → dim the other
    draw(device, framebuffer, circles);

    const hovered = px(device, framebuffer, 20, 32); // group 0 → kept full
    const dimmed = px(device, framebuffer, 44, 32); // group 1 → dimmed
    expect(hovered[3]!).toBeGreaterThan(200); // hovered stays opaque
    expect(dimmed[3]!).toBeGreaterThan(0);
    expect(dimmed[3]!).toBeLessThan(hovered[3]!); // the non-hovered circle faded
    circles.destroy();
    device.destroy();
  });

  it("tints a hovered link toward red in place, keeping the geometry (weight-preserving recolour)", async () => {
    const { device, framebuffer } = await setup();
    // A thick gray horizontal line across the middle; its group (source id) = 7.
    const data = { sources: new Float32Array([8, 32]), targets: new Float32Array([56, 32]), widths: new Float32Array([10]), colors: new Uint8Array([150, 150, 150, 255]), groups: new Float32Array([7]), count: 1 };
    const lines = new InstancedLines(device, data, W, H);
    lines.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    draw(device, framebuffer, lines);
    const gray = px(device, framebuffer, 32, 32);
    expect(Math.abs(gray[0]! - gray[1]!)).toBeLessThan(24); // base: gray (r ≈ g)

    lines.setHighlight({ hoverGroup: 7 }); // hover the link's source → recolour toward red
    draw(device, framebuffer, lines);
    const red = px(device, framebuffer, 32, 32);
    expect(red[0]!).toBeGreaterThan(red[1]! + 30); // R clearly dominant
    expect(red[0]!).toBeGreaterThan(red[2]! + 30);
    lines.destroy();
    device.destroy();
  });
});

/** The pixel under world/px point (x, y) at k = 1 (row 0 of the read-back is the bottom). */
function at(device: Device, framebuffer: Framebuffer, x: number, y: number) {
  return px(device, framebuffer, Math.floor(x), H - 1 - Math.floor(y));
}

type Layer = { render(pass: ReturnType<Device["beginRenderPass"]>): void; renderPick(pass: ReturnType<Device["beginRenderPass"]>): void };
function draw(device: Device, framebuffer: Framebuffer, layer: Layer, pick = false): void {
  const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
  if (pick) layer.renderPick(pass);
  else layer.render(pass);
  pass.end();
  device.submit();
}
const pickId = (c: ArrayLike<number>): number => (c[0] ?? 0) + 256 * (c[1] ?? 0) + 65536 * (c[2] ?? 0) - 1;

// #542: a whole arrow (an `arrows` layer) is ONE strip of the line lane, shaft + head, the twin of
// core/arrowhead.ts `arrowOutline`.
describe("whole arrows on the line lane (#542)", () => {
  // A straight arrow (4,32)→(60,32): width 4, radius 6, size 5 ⇒ tip x = 54, base x = 44, head half-width 2 + 2·√4 = 6.
  const straight = (alpha: number): InstancedArrowsData => ({
    sources: new Float32Array([4, 32]),
    targets: new Float32Array([60, 32]),
    widths: new Float32Array([4]),
    colors: new Uint8Array([0, 0, 255, alpha]),
    radii: new Float32Array([6]),
    arrowSize: 5,
    count: 1,
  });

  function checkStraight(device: Device, framebuffer: Framebuffer, scale: number): void {
    const p = (x: number, y: number) => at(device, framebuffer, x * scale, y * scale);
    expect(p(52, 32)[3]).toBeGreaterThan(0); // the head reaches the tip …
    expect(p(54, 32)[3]).toBe(0); // … and stops there: tip = target − dir·radius
    expect(p(57, 32)[3]).toBe(0); // no shaft between the tip and the target
    expect(p(52, 33)[3]).toBe(0); // no line edge beside the tip (the head is narrower than the line here)
    expect(p(52, 34)[3]).toBe(0);
    expect(p(45, 36)[3]).toBeGreaterThan(0); // the barbs stick out beyond the line on both sides
    expect(p(45, 27)[3]).toBeGreaterThan(0);
    // No gap and no double blend: every pixel along the arrow and across the shaft–head join has the single-layer alpha.
    for (let x = 5; x < 53; x++) expect(Math.abs((p(x, 32)[3] ?? 0) - 128), `x=${x}`).toBeLessThanOrEqual(2);
    for (let x = 40; x < 48; x++) for (const y of [30, 31, 32, 33]) expect(Math.abs((p(x, y)[3] ?? 0) - 128), `${x},${y}`).toBeLessThanOrEqual(2);
  }

  it("world sizeMode: tip at target − radius, no line beside the tip, no gap, a translucent arrow blends once", async () => {
    const { device, framebuffer } = await setup();
    const lines = new InstancedLines(device, straight(128), W, H, false, "arrow");
    lines.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    draw(device, framebuffer, lines);
    checkStraight(device, framebuffer, 1);
    lines.destroy();
    device.destroy();
  });

  it("screen sizeMode: width, radius and size in px around the projected ends", async () => {
    const { device, framebuffer } = await setup();
    const d = straight(128);
    // Ends at half the coordinates under k = 2 project to the world test's px.
    const lines = new InstancedLines(device, { ...d, sources: new Float32Array([2, 16]), targets: new Float32Array([30, 16]) }, W, H, false, "arrow");
    lines.setTransform(clipFromView({ k: 2, x: 0, y: 0 }, W, H));
    lines.setSizeMode("screen");
    draw(device, framebuffer, lines);
    checkStraight(device, framebuffer, 1);
    lines.destroy();
    device.destroy();
  });

  it("a bent line gets a full symmetric head on its own end tangent, with the tip on the node boundary", async () => {
    const { device, framebuffer } = await setup();
    const a: ArrowParams = { sx: 8, sy: 36, tx: 56, ty: 36, radius: 5, width: 3, size: 4, bend: 0.25 };
    const lines = new InstancedLines(
      device,
      {
        sources: new Float32Array([a.sx, a.sy]),
        targets: new Float32Array([a.tx, a.ty]),
        widths: new Float32Array([a.width]),
        colors: new Uint8Array([255, 0, 0, 255]),
        bends: new Float32Array([a.bend]),
        samples: 16,
        radii: new Float32Array([a.radius]),
        arrowSize: a.size,
        count: 1,
      },
      W,
      H,
      false,
      "arrow",
    );
    lines.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    draw(device, framebuffer, lines);
    const h = new Float64Array(6);
    arrowHead(h, 0, a); // left barb, tip, right barb
    const [lx, ly, tx, ty, rx, ry] = Array.from(h);
    const ux = (tx - (lx + rx) / 2) / 8; // head axis (length 2·size = 8)
    const uy = (ty - (ly + ry) / 2) / 8;
    expect(Math.hypot(tx - a.tx, ty - a.ty)).toBeCloseTo(a.radius, 5);
    expect(at(device, framebuffer, tx - 2 * ux, ty - 2 * uy)[0]).toBeGreaterThan(200); // just behind the tip
    expect(at(device, framebuffer, tx + 2 * ux, ty + 2 * uy)[3]).toBe(0); // past the tip: nothing
    // Both barbs drawn (a full head, not the one-sided half head), each a little inside its corner.
    for (const [bx, by] of [[lx, ly], [rx, ry]] as const) {
      const cx = (lx + rx) / 2, cy = (ly + ry) / 2; // base centre
      const ix = cx + 0.65 * (bx - cx) + 1.2 * ux, iy = cy + 0.65 * (by - cy) + 1.2 * uy;
      expect(at(device, framebuffer, ix, iy)[0], `barb ${bx},${by}`).toBeGreaterThan(100);
    }
    lines.destroy();
    device.destroy();
  });

  it("a pick on a head pixel returns the arrow's own id (+ pick base); zero radii put the tip on the target", async () => {
    const { device, framebuffer } = await setup();
    const lines = new InstancedLines(
      device,
      {
        sources: new Float32Array([4, 12, 4, 40]),
        targets: new Float32Array([60, 12, 60, 40]),
        widths: new Float32Array([2, 2]),
        colors: new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255]),
        radii: new Float32Array(2),
        arrowSize: 5,
        count: 2,
      },
      W,
      H,
      true,
      "arrow",
    );
    lines.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    draw(device, framebuffer, lines, true);
    expect(pickId(at(device, framebuffer, 58, 40))).toBe(1); // the head near the target (radius 0)
    expect(pickId(at(device, framebuffer, 52, 42))).toBe(1); // a barb, beyond the line's width
    expect(pickId(at(device, framebuffer, 52, 14))).toBe(0);
    lines.setPickBase(100);
    draw(device, framebuffer, lines, true);
    expect(pickId(at(device, framebuffer, 52, 42))).toBe(101);
    lines.destroy();
    device.destroy();
  });

  it("indexed lane: the radius comes from an r32float edge table; head pixels pick the edge id", async () => {
    const { device, framebuffer } = await setup();
    const lines = new IndexedLines(
      device,
      {
        index: new Float32Array([1]),
        tableCount: 2,
        sources: new Float32Array([4, 32]),
        targets: new Float32Array([60, 32]),
        widths: new Float32Array([1, 4]),
        colors: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]),
        radii: new Float32Array([0, 6]),
        arrowSize: 5,
        count: 1,
      },
      W,
      H,
      true,
      true,
    );
    lines.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    draw(device, framebuffer, lines);
    checkStraight(device, framebuffer, 1);
    draw(device, framebuffer, lines, true);
    expect(pickId(at(device, framebuffer, 50, 32))).toBe(1);
    expect(pickId(at(device, framebuffer, 45, 36))).toBe(1);
    lines.destroy();
    device.destroy();
  });

  it("costs 4 B/instance (radius) and uploads no radius on a position frame; headless lines add nothing", async () => {
    const { device } = await setup();
    const base = straight(255);
    const radii = new Float32Array([6, 6, 6]);
    const data: InstancedArrowsData = {
      ...base,
      sources: new Float32Array(6),
      targets: new Float32Array(6).fill(30),
      widths: new Float32Array(3).fill(2),
      colors: new Uint8Array(12).fill(255),
      radii,
      count: 3,
    };
    const b0 = radiusColumnStats.buffers, n0 = radiusColumnStats.bytes;
    const lines = new InstancedLines(device, data, W, H, false, "arrow");
    expect(radiusColumnStats.buffers - b0).toBe(1);
    expect(radiusColumnStats.bytes - n0).toBe(4 * 3);
    // A position frame: new ends, the same radii ⇒ no radius upload; a new size is a uniform.
    expect(lines.update(device, { ...data, sources: new Float32Array(6).fill(1), arrowSize: 7 }, "arrow")).toBe(true);
    expect(radiusColumnStats.bytes - n0).toBe(4 * 3);
    // A `lines` layer in its place changes the program: the caller recreates.
    expect(lines.update(device, data, "none")).toBe(false);
    lines.destroy();
    const plain = new InstancedLines(device, data, W, H);
    plain.update(device, { ...data, sources: new Float32Array(6).fill(2) });
    expect(radiusColumnStats.buffers - b0).toBe(1);
    expect(radiusColumnStats.bytes - n0).toBe(4 * 3);
    plain.destroy();
    device.destroy();
  });
});
