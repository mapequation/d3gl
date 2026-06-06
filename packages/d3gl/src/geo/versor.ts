/**
 * versor — quaternion helpers for trackball-style globe rotation.
 *
 * Ported (TypeScript) from d3/versor by Mike Bostock and Philippe Rivière,
 * ISC License (https://github.com/d3/versor). Internal to @mapequation/d3gl;
 * used by GeoMap.enableRotation to rotate a spherical projection from pointer
 * drags. Not part of the public export surface.
 */
type Vec3 = [number, number, number];
type Quaternion = [number, number, number, number];
/** Projection rotation triple `[lambda, phi, gamma]` in degrees. */
export type Angles = [number, number, number];

const { acos, asin, atan2, cos, max, min, PI, sin, sqrt } = Math;
const radians = PI / 180;
const degrees = 180 / PI;

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Quaternion for a projection rotation `[lambda, phi, gamma]` (degrees). */
function versor(e: Angles): Quaternion {
  const l = (e[0] / 2) * radians, sl = sin(l), cl = cos(l);
  const p = (e[1] / 2) * radians, sp = sin(p), cp = cos(p);
  const g = (e[2] / 2) * radians, sg = sin(g), cg = cos(g);
  return [
    cl * cp * cg + sl * sp * sg,
    sl * cp * cg - cl * sp * sg,
    cl * sp * cg + sl * cp * sg,
    cl * cp * sg - sl * sp * cg,
  ];
}

/** Unit cartesian vector for a `[lon, lat]` (degrees) coordinate. */
versor.cartesian = function (e: [number, number]): Vec3 {
  const l = e[0] * radians, p = e[1] * radians, cp = cos(p);
  return [cp * cos(l), cp * sin(l), sin(p)];
};

/** Euler angles `[lambda, phi, gamma]` (degrees) for a quaternion. */
versor.rotation = function (q: Quaternion): Angles {
  return [
    atan2(2 * (q[0] * q[1] + q[2] * q[3]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) * degrees,
    asin(max(-1, min(1, 2 * (q[0] * q[2] - q[3] * q[1])))) * degrees,
    atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3])) * degrees,
  ];
};

/** Quaternion rotating unit vector `v0` to `v1` (by fraction `alpha`). */
versor.delta = function (v0: Vec3, v1: Vec3, alpha = 1): Quaternion {
  const w = cross(v0, v1), l = sqrt(dot(w, w));
  if (!l) return [1, 0, 0, 0];
  const t = (alpha * acos(max(-1, min(1, dot(v0, v1))))) / 2, s = sin(t);
  return [cos(t), (w[2] / l) * s, -(w[1] / l) * s, (w[0] / l) * s];
};

/** Hamilton product of two quaternions. */
versor.multiply = function (q0: Quaternion, q1: Quaternion): Quaternion {
  return [
    q0[0] * q1[0] - q0[1] * q1[1] - q0[2] * q1[2] - q0[3] * q1[3],
    q0[0] * q1[1] + q0[1] * q1[0] + q0[2] * q1[3] - q0[3] * q1[2],
    q0[0] * q1[2] - q0[1] * q1[3] + q0[2] * q1[0] + q0[3] * q1[1],
    q0[0] * q1[3] + q0[1] * q1[2] - q0[2] * q1[1] + q0[3] * q1[0],
  ];
};

export default versor;
export type { Vec3, Quaternion };
