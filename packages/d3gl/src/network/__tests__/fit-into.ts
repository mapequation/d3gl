/**
 * Scale interleaved `[x, y, …]` positions uniformly into a `size`-wide box at the origin, in place.
 *
 * The LOD perf fixtures (`frontier-perf`, `super-edges-perf`, `lod-perf.bench`, `lod-drag-incremental-perf`)
 * lay their graph out with the real multilevel seed, which sits at the force model's equilibrium scale
 * (#345: ~21k across at 100k nodes). Their budgets and tolerances were calibrated on a layout about 2000
 * units across with fixed 4-unit world radii: the node-radius-to-extent ratio sets how much declutter keeps
 * and how deep the sweep's frontier opens, and the coordinate magnitude sets the Float32 error of an
 * incremental centroid update. Fitting the seed into that box keeps each guard's workload what it was
 * calibrated on, whatever scale the seed lands at.
 */
export function fitInto(p: Float32Array, size: number): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < p.length; i += 2) {
    const x = p[i] ?? 0, y = p[i + 1] ?? 0;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const s = size / Math.max(maxX - minX, maxY - minY, 1e-9);
  for (let i = 0; i + 1 < p.length; i += 2) {
    p[i] = ((p[i] ?? 0) - minX) * s;
    p[i + 1] = ((p[i + 1] ?? 0) - minY) * s;
  }
}
