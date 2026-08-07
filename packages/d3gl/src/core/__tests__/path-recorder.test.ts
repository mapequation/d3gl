import { describe, it, expect } from "vitest";
import { PathRecorder } from "../path-recorder.js";

describe("PathRecorder", () => {
  it("records a single open polyline", () => {
    const r = new PathRecorder();
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.lineTo(10, 10);
    const paths = r.subpaths;
    expect(paths).toHaveLength(1);
    expect(paths[0]!.points).toEqual([0, 0, 10, 0, 10, 10]);
    expect(paths[0]!.closed).toBe(false);
  });

  it("marks a subpath closed on closePath()", () => {
    const r = new PathRecorder();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.lineTo(10, 10);
    r.closePath();
    expect(r.subpaths[0]!.closed).toBe(true);
  });

  it("starts a new subpath on each moveTo", () => {
    const r = new PathRecorder();
    r.moveTo(0, 0);
    r.lineTo(1, 1);
    r.moveTo(5, 5);
    r.lineTo(6, 6);
    expect(r.subpaths).toHaveLength(2);
    expect(r.subpaths[1]!.points).toEqual([5, 5, 6, 6]);
  });

  it("beginPath() clears previously recorded subpaths", () => {
    const r = new PathRecorder();
    r.moveTo(0, 0);
    r.lineTo(1, 1);
    r.beginPath();
    r.moveTo(2, 2);
    r.lineTo(3, 3);
    expect(r.subpaths).toHaveLength(1);
    expect(r.subpaths[0]!.points).toEqual([2, 2, 3, 3]);
  });

  it("flattens bezierCurveTo into multiple points ending at the endpoint", () => {
    const r = new PathRecorder();
    r.moveTo(0, 0);
    r.bezierCurveTo(0, 10, 10, 10, 10, 0);
    const pts = r.subpaths[0]!.points;
    expect(pts.length / 2).toBeGreaterThan(2);
    expect(pts.slice(-2)).toEqual([10, 0]);
  });

  it("expands rect() into a closed 4-corner subpath", () => {
    const r = new PathRecorder();
    r.rect(0, 0, 10, 20);
    const sp = r.subpaths[0]!;
    expect(sp.closed).toBe(true);
    expect(sp.points).toEqual([0, 0, 10, 0, 10, 20, 0, 20]);
  });

  it("flattens arcTo into a tangent arc (geometry pinned in arc-to.test.ts)", () => {
    const r = new PathRecorder();
    r.moveTo(0, 0);
    r.arcTo(10, 0, 10, 10, 5);
    const pts = r.subpaths[0]!.points;
    expect(pts.length / 2).toBeGreaterThan(3);
    expect(pts.slice(0, 2)).toEqual([0, 0]);
  });

  it("bakes translate() into every subsequent path coordinate", () => {
    const r = new PathRecorder();
    r.translate(100, 50);
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.rect(0, 0, 5, 5);
    expect(r.subpaths[0]!.points).toEqual([100, 50, 110, 50]);
    expect(r.subpaths[1]!.points).toEqual([100, 50, 105, 50, 105, 55, 100, 55]);
  });

  it("accumulates successive translate() calls like canvas", () => {
    const r = new PathRecorder();
    r.translate(10, 10);
    r.translate(5, 0);
    r.moveTo(0, 0);
    expect(r.subpaths[0]!.points).toEqual([15, 10]);
  });

  it("offsets an arc's centre and start point by translate()", () => {
    const r = new PathRecorder();
    r.translate(100, 100);
    r.arc(0, 0, 10, 0, Math.PI / 2);
    const pts = r.subpaths[0]!.points;
    // Start at centre + (r, 0) = (110, 100); arc stays a radius-10 circle about (100, 100).
    expect(pts.slice(0, 2)).toEqual([110, 100]);
    expect(pts.slice(-2)[0]).toBeCloseTo(100, 6);
    expect(pts.slice(-2)[1]).toBeCloseTo(110, 6);
  });

  it("offsets an origin-centred generator path (radial-tree idiom)", () => {
    // moveTo with no prior point still honours the offset (the lineTo→moveTo fallback path).
    const r = new PathRecorder();
    r.translate(7, 3);
    r.lineTo(1, 1);
    expect(r.subpaths[0]!.points).toEqual([8, 4]);
  });
});
