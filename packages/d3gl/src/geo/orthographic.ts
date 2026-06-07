import { geoOrthographic } from "d3-geo";
import type { GeoProjection } from "d3-geo";

const DEG = Math.PI / 180;

/** Multiply two column-major mat3s (a · b). */
function mul(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++)
      o[c * 3 + r] = a[r]! * b[c * 3]! + a[3 + r]! * b[c * 3 + 1]! + a[6 + r]! * b[c * 3 + 2]!;
  return o;
}
// Axis rotations, column-major. Right-handed about each basis axis.
function rotX(a: number): number[] {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, s, 0, -s, c];
}
function rotY(a: number): number[] {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
}
function rotZ(a: number): number[] {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/**
 * 3D rotation matrix (column-major mat3, the layout GLSL `mat3 * vec3` consumes)
 * matching d3 `geoOrthographic().rotate([λ,φ,γ])` in OUR cartesian basis
 * (X = cosφ·sinλ, Y = sinφ, Z = cosφ·cosλ, with φ=lat, λ=lon). Pinned empirically
 * against d3 in src/geo/__tests__/rotation-matrix.test.ts.
 */
export function rotationMatrix(angles: [number, number, number]): Float32Array {
  const [lam, phi, gam] = angles;
  // d3 rotate([λ,φ,γ]): yaw λ about the pole (Y), then tilt φ, then roll γ.
  const m = mul(mul(rotZ(gam * DEG), rotX(-phi * DEG)), rotY(lam * DEG));
  return new Float32Array(m);
}

// Sample lon/lat points spread across a hemisphere; orthographic must agree with a
// reference geoOrthographic carrying the same scale/translate/rotate/clipAngle at all
// of them (within epsilon). Non-orthographic azimuthals diverge in their radial profile.
const SAMPLES: [number, number][] = [[0, 0], [20, 35], [-40, 10], [15, -25]];
const EPS = 1e-3;

/** True if `p` behaves like d3.geoOrthographic (so the GPU globe path can drive it). */
export function isOrthographic(p: GeoProjection): boolean {
  const ref = geoOrthographic()
    .scale(p.scale())
    .translate(p.translate())
    .rotate(p.rotate())
    .clipAngle(p.clipAngle());
  if (typeof (p as { precision?: () => number }).precision === "function") {
    ref.precision((p as unknown as { precision: () => number }).precision());
  }
  for (const s of SAMPLES) {
    const a = p(s);
    const b = ref(s);
    if (!a || !b) {
      if (Boolean(a) !== Boolean(b)) return false; // one clipped the point, the other didn't
      continue;
    }
    if (Math.abs(a[0] - b[0]) > EPS || Math.abs(a[1] - b[1]) > EPS) return false;
  }
  return true;
}
