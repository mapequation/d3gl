import { describe, it, expect } from "vitest";
import versor from "../versor.js";

const close = (a: number[], b: number[], tol = 1e-6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, Math.round(-Math.log10(tol))));
};

describe("versor", () => {
  it("builds identity quaternion from zero angles", () => {
    close(versor([0, 0, 0]), [1, 0, 0, 0]);
  });
  it("maps lon/lat to cartesian unit vectors", () => {
    close(versor.cartesian([0, 0]), [1, 0, 0]);
    close(versor.cartesian([90, 0]), [0, 1, 0]);
    close(versor.cartesian([0, 90]), [0, 0, 1]);
  });
  it("recovers euler angles from identity quaternion", () => {
    close(versor.rotation([1, 0, 0, 0]), [0, 0, 0]);
  });
  it("returns the identity quaternion for a zero delta", () => {
    const v = versor.cartesian([12, 34]);
    close(versor.delta(v, v), [1, 0, 0, 0]);
  });
  it("round-trips rotation(versor(angles))", () => {
    close(versor.rotation(versor([20, 10, 0])), [20, 10, 0], 1e-6);
  });
  it("composes a non-identity rotation from two distinct points", () => {
    const q = versor.multiply(
      versor([0, 0, 0]),
      versor.delta(versor.cartesian([0, 0]), versor.cartesian([30, 10])),
    );
    const r = versor.rotation(q);
    expect(Math.hypot(r[0], r[1], r[2])).toBeGreaterThan(1);
  });
});
