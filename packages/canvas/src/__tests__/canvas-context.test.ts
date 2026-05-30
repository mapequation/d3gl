import { describe, it, expect, vi } from "vitest";
import { CanvasContext } from "../canvas-context.js";

/** A fake 2D context that records the calls made to it. */
function fakeCtx() {
  return {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    arcTo: vi.fn(),
    rect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  };
}

describe("CanvasContext", () => {
  it("forwards path calls to the underlying 2D context", () => {
    const raw = fakeCtx();
    const ctx = new CanvasContext(raw as unknown as CanvasRenderingContext2D);
    ctx.beginPath();
    ctx.moveTo(1, 2);
    ctx.lineTo(3, 4);
    ctx.closePath();
    expect(raw.beginPath).toHaveBeenCalledOnce();
    expect(raw.moveTo).toHaveBeenCalledWith(1, 2);
    expect(raw.lineTo).toHaveBeenCalledWith(3, 4);
    expect(raw.closePath).toHaveBeenCalledOnce();
  });

  it("fill(style) sets fillStyle then calls fill()", () => {
    const raw = fakeCtx();
    const ctx = new CanvasContext(raw as unknown as CanvasRenderingContext2D);
    ctx.fill("#ff0000");
    expect(raw.fillStyle).toBe("#ff0000");
    expect(raw.fill).toHaveBeenCalledOnce();
  });

  it("stroke(style, width) sets strokeStyle and lineWidth then strokes", () => {
    const raw = fakeCtx();
    const ctx = new CanvasContext(raw as unknown as CanvasRenderingContext2D);
    ctx.stroke("#00ff00", 2.5);
    expect(raw.strokeStyle).toBe("#00ff00");
    expect(raw.lineWidth).toBe(2.5);
    expect(raw.stroke).toHaveBeenCalledOnce();
  });
});
