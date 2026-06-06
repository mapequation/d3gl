import { geoOrthographic } from "d3-geo";
import type { GeoProjection } from "d3-geo";

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
