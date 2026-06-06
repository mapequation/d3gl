import { describe, it, expect } from "vitest";
import { geoOrthographic } from "d3-geo";
import { rotationMatrix } from "../orthographic.js";

// The GPU globe shader places a lon/lat vertex as:
//   dir = (cos(lat)·sin(lon), sin(lat), cos(lat)·cos(lon))   // OUR cartesian basis
//   r   = u_rotation · dir                                   // column-major mat3 · vec3
//   px  = center + (r.x, -r.y)·scale
// For the GPU sphere to show EXACTLY what geoOrthographic().rotate([λ,φ,γ]) shows,
// rotationMatrix([λ,φ,γ]) must equal d3's rotate in OUR basis. This pins it empirically.

const DEG = Math.PI / 180;

/** Column-major mat3 (the layout GLSL `mat3(m) * v` consumes) times a vec3. */
function applyMat3(m: Float32Array, v: [number, number, number]): [number, number, number] {
  // column-major: m[0..2]=col0, m[3..5]=col1, m[6..8]=col2.
  return [
    m[0]! * v[0] + m[3]! * v[1] + m[6]! * v[2],
    m[1]! * v[0] + m[4]! * v[1] + m[7]! * v[2],
    m[2]! * v[0] + m[5]! * v[1] + m[8]! * v[2],
  ];
}

const SAMPLES: [number, number][] = [[0, 0], [30, 20], [-45, 15], [80, -30]];
const ROTATIONS: [number, number, number][] = [
  [0, 0, 0], [40, 0, 0], [40, -20, 0], [20, -35, 15],
];
const S = 120;
const EPS = 1e-3;

describe("rotationMatrix matches geoOrthographic.rotate", () => {
  for (const rot of ROTATIONS) {
    it(`rotate=${JSON.stringify(rot)}`, () => {
      const [lam, phi, gam] = rot;
      const p = geoOrthographic().scale(S).translate([0, 0]).rotate([lam, phi, gam]);
      const m = rotationMatrix(rot);
      let checked = 0;
      for (const [lon, lat] of SAMPLES) {
        const dir: [number, number, number] = [
          Math.cos(lat * DEG) * Math.sin(lon * DEG),
          Math.sin(lat * DEG),
          Math.cos(lat * DEG) * Math.cos(lon * DEG),
        ];
        const r = applyMat3(m, dir);
        if (r[2] <= 0) continue; // back hemisphere: not shown by orthographic
        const gpu = [r[0] * S, -r[1] * S];
        const proj = p([lon, lat]);
        expect(proj, `point [${lon},${lat}] should be on the front`).toBeTruthy();
        expect(Math.abs(proj![0] - gpu[0])).toBeLessThan(EPS);
        expect(Math.abs(proj![1] - gpu[1])).toBeLessThan(EPS);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    });
  }
});
